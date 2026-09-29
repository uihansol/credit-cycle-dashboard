// ============================================================
// data-loader.js — 저장소의 ./data/*.csv 만 읽는다.
// FRED 직접 접속, CORS 프록시, 외부 데이터 API는 사용하지 않는다.
// ============================================================
import { DATA_PATH } from './config.js';

export class DataLoadError extends Error {
  /** @param {{file:string, reason:string}[]} failures */
  constructor(failures) {
    super('저장된 FRED 데이터를 불러오지 못했습니다.');
    this.failures = failures;
  }
}

/**
 * FRED CSV 파싱: 1열 = 날짜, 2열 = 값. "." 또는 빈 값 → null.
 * @returns {Map<string, number|null>}
 */
export function parseFredCsv(text, fileName = 'CSV') {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const header = (lines[0] || '').split(',');
  if (header.length < 2 || /<html|<!doctype/i.test(text.slice(0, 200))) {
    throw new Error(`${fileName}의 형식이 FRED CSV가 아닙니다 (첫 줄: "${(lines[0] || '').slice(0, 60)}").`);
  }
  const out = new Map();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const comma = line.indexOf(',');
    if (comma < 0) continue;
    const date = line.slice(0, comma).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const raw = line.slice(comma + 1).trim();
    const num = raw === '' || raw === '.' ? NaN : Number(raw);
    out.set(date, Number.isFinite(num) ? num : null);
  }
  return out;
}

async function fetchCsv(seriesId, { bust = false } = {}) {
  const file = `${seriesId}.csv`;
  const url = `${DATA_PATH}${file}${bust ? `?t=${Date.now()}` : ''}`;
  let res;
  try {
    res = await fetch(url, { cache: bust ? 'no-store' : 'no-cache' });
  } catch (e) {
    throw { file, reason: `요청 실패 (${e.message}). index.html을 파일로 직접 열었다면 GitHub Pages나 로컬 서버에서 열어 주세요.` };
  }
  if (!res.ok) {
    const hint = res.status === 404
      ? '파일이 없습니다. GitHub Actions 업데이트가 한 번 이상 성공했는지 확인하세요.'
      : `HTTP ${res.status}`;
    throw { file, reason: hint };
  }
  const text = await res.text();
  let map;
  try {
    map = parseFredCsv(text, file);
  } catch (e) {
    throw { file, reason: e.message };
  }
  const valid = [...map.values()].filter((v) => v !== null).length;
  if (valid === 0) throw { file, reason: '유효한 관측치가 하나도 없습니다.' };
  return map;
}

const cache = new Map(); // seriesId → Map

/** 가장 최근 loadSeries()에서 optional로 허용하고 건너뛴 시리즈 키 → 사유 */
export const skippedSeries = new Map();

/**
 * 여러 시리즈를 동시에 불러온다. 하나라도 실패하면 실패한 파일 목록 전체를 담아 throw.
 * optional에 든 키는 실패해도 오류로 치지 않고 빈 Map으로 채운다 (skippedSeries에 사유 기록).
 * @param {Record<string,string>} files  { BAA:'DBAA', ... }
 * @param {{refresh?:boolean, optional?:string[]}} [opts]
 * @returns {Promise<Record<string, Map<string, number|null>>>}
 */
export async function loadSeries(files, { refresh = false, optional = [] } = {}) {
  const entries = Object.entries(files);
  const results = await Promise.allSettled(
    entries.map(async ([, id]) => {
      if (!refresh && cache.has(id)) return cache.get(id);
      const map = await fetchCsv(id, { bust: refresh });
      cache.set(id, map);
      return map;
    }),
  );
  const failures = [];
  const out = {};
  results.forEach((r, i) => {
    const [key, id] = entries[i];
    if (r.status === 'fulfilled') { out[key] = r.value; skippedSeries.delete(key); }
    else if (optional.includes(key)) {
      out[key] = new Map();
      skippedSeries.set(key, r.reason?.reason || String(r.reason));
    } else failures.push(r.reason?.file ? r.reason : { file: `${id}.csv`, reason: String(r.reason) });
  });
  if (failures.length) throw new DataLoadError(failures);
  return out;
}

/** meta.json (업데이트 시각). 없어도 대시보드는 동작한다. */
export async function loadMeta() {
  try {
    const res = await fetch(`${DATA_PATH}meta.json?t=${Date.now()}`, { cache: 'no-store' });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
