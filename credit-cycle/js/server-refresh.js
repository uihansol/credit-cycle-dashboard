// ============================================================
// server-refresh.js — "서버에서 최신 데이터 받아 CSV 갱신" 요청 (GitHub Actions 호출)
//
// 브라우저는 FRED에 직접 접속하지 않는다(CORS·키 노출 문제). 대신 이 저장소의 데이터 갱신 워크플로
// (update-fred-credit-cycle.yml)를 GitHub API로 실행시키고, 워크플로가 FRED → data/*.csv 를 갱신·커밋하면
// 사이트가 반영된 CSV 를 다시 읽는다. 워크플로 실행에는 GitHub 토큰(fine-grained, 이 저장소 한정,
// Actions: Read and write)이 필요하며, 입력한 토큰은 이 브라우저의 localStorage 에만 저장된다.
// ============================================================
import { loadMeta } from './data-loader.js';

export const WORKFLOW_FILE = 'update-fred-credit-cycle.yml';
const TOKEN_KEY = 'credit-cycle:gh-token';
const API = 'https://api.github.com';

/** 사이트 주소(https://OWNER.github.io/REPO/…)에서 저장소를 추정한다. 아니면 기본값. */
export function detectRepo(loc = globalThis.location, fallback = 'uihansol/credit-cycle-dashboard') {
  try {
    const m = /^([\w-]+)\.github\.io$/i.exec(loc.hostname);
    const repo = loc.pathname.split('/').filter(Boolean)[0];
    if (m && repo) return `${m[1]}/${repo}`;
  } catch { /* ignore */ }
  return fallback;
}

// 저장소 접근이 막힌 환경(시크릿 창 등)에서도 앱이 죽지 않게 try/catch 로 감싼다.
export function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }
export function setToken(t) { try { localStorage.setItem(TOKEN_KEY, t.trim()); return true; } catch { return false; } }
export function clearToken() { try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } }

export class RefreshError extends Error {
  /** @param {string} message @param {{auth?:boolean, url?:string}} [extra] */
  constructor(message, extra = {}) { super(message); this.name = 'RefreshError'; Object.assign(this, extra); }
}

async function gh(path, token, init = {}) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
  } catch (e) {
    throw new RefreshError(`GitHub에 연결하지 못했습니다 (${e.message}). 네트워크를 확인하세요.`);
  }
  if (res.status === 401) throw new RefreshError('토큰이 올바르지 않거나 만료되었습니다.', { auth: true });
  if (res.status === 403 || res.status === 404) {
    throw new RefreshError('토큰 권한이 부족합니다. 이 저장소에 대해 “Actions: Read and write” 권한이 있는 토큰이 필요합니다.', { auth: true });
  }
  if (!res.ok) throw new RefreshError(`GitHub 응답 오류 (HTTP ${res.status}).`);
  return res.status === 204 ? null : res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 워크플로를 실행시키고 끝날 때까지 기다린다.
 * @param {string} token
 * @param {{repo?:string, ref?:string, onStatus?:(msg:string)=>void, intervalMs?:number, timeoutMs?:number}} [opts]
 * @returns {Promise<{dataChanged:boolean, runUrl:string}>}
 *   dataChanged: 이 실행이 새 데이터를 커밋했는가 (true 면 사이트 반영(Pages 배포)을 더 기다려야 한다)
 */
export async function runServerUpdate(token, opts = {}) {
  const repo = opts.repo || detectRepo();
  const ref = opts.ref || 'main';
  const say = opts.onStatus || (() => {});
  const every = opts.intervalMs ?? 4000;
  const deadline = Date.now() + (opts.timeoutMs ?? 4 * 60 * 1000);

  // 기준선: 실행 전 최신 실행 번호와 브랜치 최신 커밋
  const runsPath = `/repos/${repo}/actions/workflows/${WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=5`;
  const before = await gh(runsPath, token);
  const baseRunId = Math.max(0, ...before.workflow_runs.map((r) => r.id));
  const baseSha = (await gh(`/repos/${repo}/commits/${ref}`, token)).sha;

  say('서버에 갱신 요청 중…');
  await gh(`/repos/${repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`, token, {
    method: 'POST', body: JSON.stringify({ ref }),
  });

  // 새 실행이 나타나면 끝날 때까지 추적
  let run = null;
  while (Date.now() < deadline) {
    await sleep(every);
    const list = await gh(runsPath, token);
    run = list.workflow_runs.filter((r) => r.id > baseRunId).sort((a, b) => b.id - a.id)[0] || null;
    if (!run) { say('서버가 실행을 시작하길 기다리는 중…'); continue; }
    if (run.status === 'completed') break;
    say('서버가 FRED에서 최신 데이터를 받는 중…');
  }
  if (!run || run.status !== 'completed') {
    throw new RefreshError('서버 갱신이 제한 시간 안에 끝나지 않았습니다. 잠시 뒤 다시 시도하세요.', { url: run?.html_url });
  }
  if (run.conclusion !== 'success') {
    throw new RefreshError('서버 갱신 작업이 실패했습니다. Actions 로그에서 원인을 확인하세요.', { url: run.html_url });
  }

  // 새 데이터가 있었다면 워크플로가 main 에 커밋을 남긴다
  const afterSha = (await gh(`/repos/${repo}/commits/${ref}`, token)).sha;
  return { dataChanged: afterSha !== baseSha, runUrl: run.html_url };
}

/**
 * 새 CSV 가 사이트(GitHub Pages)에 반영될 때까지 meta.json 을 지켜본다.
 * @returns {Promise<boolean>} 반영 확인 여부
 */
export async function waitForSiteUpdate(prevUpdatedAt, { onStatus = () => {}, intervalMs = 5000, timeoutMs = 2 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const meta = await loadMeta();
    if (meta && meta.updated_at !== prevUpdatedAt) return true;
    onStatus('새 데이터가 사이트에 반영되길 기다리는 중…');
    await sleep(intervalMs);
  }
  return false;
}
