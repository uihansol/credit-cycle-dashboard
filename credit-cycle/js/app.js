// ============================================================
// app.js — 상태 관리 + UI 연결 (진입점)
// ============================================================
import {
  FREQUENCIES, VERSIONS, Y_AXIS,
  DEFAULT_FREQ, DEFAULT_VERSION, DEFAULT_MARKER_SIZE,
} from './config.js';
import { loadSeries, loadMeta, DataLoadError } from './data-loader.js';
import {
  alignSeries, aggregateAnnualMean, filterByDate, computePoints,
  formatDateLabel, summarize,
} from './transform.js';
import {
  renderTimeSeries, renderTrajectory, setTrajectoryMarkerSize, clearChart, COLORS,
} from './charts.js';
import { buildOverlays } from './overlays.js';

// ------------------------------------------------------------ 상태
const state = {
  version: DEFAULT_VERSION,
  freq: DEFAULT_FREQ,
  start: FREQUENCIES[DEFAULT_FREQ].minDate,
  end: '',
  endAuto: true,          // 사용자가 종료일을 직접 바꾸기 전까지 최신일을 따라감
  markerSize: DEFAULT_MARKER_SIZE,
  rows: {},               // freq → 정렬된 원자료 행
  latest: {},             // freq → 마지막 관측 날짜 (YYYY-MM-DD)
  features: {},           // 향후 확장 기능 on/off (overlays.js 참고)
};

// ------------------------------------------------------------ DOM
const $ = (id) => document.getElementById(id);
const el = {
  version: $('version'), freq: $('freq'), start: $('start'), end: $('end'),
  size: $('marker-size'), sizeOut: $('marker-size-out'), reload: $('reload'),
  notice: $('notice'), status: $('status'),
  xTitle: $('x-chart-sub'), chartX: $('chart-x'), chartY: $('chart-y'),
  chartTraj: $('chart-trajectory'), trajSub: $('trajectory-sub'),
  cards: $('cards'), meta: $('data-meta'),
};

// ------------------------------------------------------------ 알림
function showNotice(kind, html) {
  el.notice.className = `notice notice--${kind}`;
  el.notice.innerHTML = html;
  el.notice.hidden = false;
}
function clearNotice() { el.notice.hidden = true; el.notice.innerHTML = ''; }
function setStatus(text) { el.status.textContent = text; }

function showLoadError(err) {
  if (err instanceof DataLoadError) {
    const items = err.failures
      .map((f) => `<li><strong>${f.file}</strong>를 불러오지 못했습니다. ${escapeHtml(f.reason)}</li>`)
      .join('');
    showNotice('error', `<p><strong>${err.message}</strong></p><ul>${items}</ul>`);
  } else {
    showNotice('error', `<p><strong>저장된 FRED 데이터를 처리하지 못했습니다.</strong></p><p>${escapeHtml(String(err.message || err))}</p>`);
  }
}
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ------------------------------------------------------------ 데이터
async function ensureRows(freq, { refresh = false } = {}) {
  if (!refresh && state.rows[freq]) return state.rows[freq];
  const cfg = FREQUENCIES[freq];
  const maps = await loadSeries(cfg.files, { refresh });
  let rows = alignSeries(maps).filter((r) => r.date >= cfg.minDate);
  state.latest[freq] = rows.length ? rows[rows.length - 1].date : '';
  if (cfg.aggregate === 'annualMean') rows = aggregateAnnualMean(rows);
  state.rows[freq] = rows;
  return rows;
}

// ------------------------------------------------------------ 날짜 규칙
/** @returns {boolean} 렌더링 가능 여부 */
function applyDateRules() {
  const cfg = FREQUENCIES[state.freq];
  el.start.min = cfg.minDate;
  el.end.min = cfg.minDate;
  const latest = state.latest[state.freq];
  if (latest) { el.start.max = latest; el.end.max = latest; }

  if (state.endAuto && latest) state.end = latest;

  const notes = [];
  if (!state.start || state.start < cfg.minDate) {
    notes.push(state.freq === 'daily'
      ? '일간 자료는 1986-01-02 이후부터 이용할 수 있습니다. 시작일을 1986-01-02로 조정했습니다.'
      : `${cfg.label}간 자료는 ${cfg.minDate} 이후부터 이용할 수 있습니다. 시작일을 조정했습니다.`);
    state.start = cfg.minDate;
  }
  el.start.value = state.start;
  el.end.value = state.end;

  if (state.end && state.start > state.end) {
    showNotice('error', '<p>시작일이 종료일보다 늦습니다. 날짜를 다시 선택해 주세요.</p>');
    return false;
  }
  if (notes.length) showNotice('info', `<p>${notes.join('<br>')}</p>`);
  else clearNotice();
  return true;
}

// ------------------------------------------------------------ 렌더링
function currentPoints() {
  const rows = filterByDate(state.rows[state.freq] || [], state.start, state.end);
  return computePoints(rows, VERSIONS[state.version], Y_AXIS);
}

function render() {
  const v = VERSIONS[state.version];
  const points = currentPoints();

  el.xTitle.textContent = v.xLabel;
  el.trajSub.textContent = `X: ${v.xShort}  ·  Y: ${Y_AXIS.short}  ·  ${FREQUENCIES[state.freq].label}간 자료, 날짜순 연결`;

  if (!points.length) {
    [el.chartX, el.chartY, el.chartTraj].forEach(clearChart);
    renderCards(null);
    showNotice('info', '<p>선택한 기간에 네 지표가 모두 있는 관측치가 없습니다. 기간을 넓혀 보세요.</p>');
    return;
  }

  renderTimeSeries(el.chartX, points, {
    accessor: (p) => p.x, label: v.xShort, digits: v.digits, freq: state.freq, color: COLORS.xSeries,
  });
  renderTimeSeries(el.chartY, points, {
    accessor: (p) => p.y, label: Y_AXIS.short, digits: Y_AXIS.digits, freq: state.freq, color: COLORS.ySeries,
  });
  renderTrajectory(el.chartTraj, points, {
    freq: state.freq, markerSize: state.markerSize,
    xLabel: v.xLabel, yLabel: Y_AXIS.label, xShort: v.xShort, yShort: Y_AXIS.short,
    xDigits: v.digits, yDigits: Y_AXIS.digits,
  }, buildOverlays(points, { version: state.version, freq: state.freq, features: state.features }));

  renderCards(points);
}

function renderCards(points) {
  const s = points ? summarize(points) : null;
  const v = VERSIONS[state.version];
  const lastLabel = s
    ? formatDateLabel(s.last.date, state.freq) +
      (s.last.raw.months && s.last.raw.months < 12 ? ` (${s.last.raw.months}개월 평균)` : '')
    : '—';
  const items = [
    ['관측치', s ? s.count.toLocaleString('ko-KR') : '—'],
    [`현재 X · ${v.xShort}`, s ? s.last.x.toFixed(v.digits) : '—'],
    [`현재 Y · ${Y_AXIS.short}`, s ? s.last.y.toFixed(Y_AXIS.digits) : '—'],
    ['시작', s ? formatDateLabel(s.first.date, state.freq) : '—'],
    ['최근', lastLabel],
  ];
  el.cards.innerHTML = items
    .map(([k, val]) => `<div class="stat"><span class="stat__label">${k}</span><span class="stat__value">${val}</span></div>`)
    .join('');
}

// ------------------------------------------------------------ 흐름
async function loadAndRender({ refresh = false } = {}) {
  el.reload.disabled = true;
  setStatus(refresh ? '저장된 CSV를 다시 읽는 중…' : '저장된 CSV를 읽는 중…');
  try {
    if (refresh) state.rows = {};
    await ensureRows(state.freq, { refresh });
    if (applyDateRules()) render();
    setStatus('');
    if (refresh) updateMeta();
  } catch (err) {
    console.error(err);
    showLoadError(err);
    [el.chartX, el.chartY, el.chartTraj].forEach(clearChart);
    renderCards(null);
    setStatus('');
  } finally {
    el.reload.disabled = false;
  }
}

async function updateMeta() {
  const meta = await loadMeta();
  if (!meta) { el.meta.textContent = '데이터 출처: FRED (저장소에 보관된 CSV)'; return; }
  const when = new Date(meta.updated_at);
  const whenText = Number.isNaN(when.getTime()) ? meta.updated_at
    : when.toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
  const m = meta.series?.BAA?.last, d = meta.series?.DBAA?.last;
  el.meta.textContent = `데이터 출처: FRED · 저장소 CSV 마지막 갱신 ${whenText}` +
    (m ? ` · 월간 최신 ${m}` : '') + (d ? ` · 일간 최신 ${d}` : '');
}

function bindControls() {
  el.version.innerHTML = Object.entries(VERSIONS)
    .map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  el.freq.innerHTML = Object.entries(FREQUENCIES)
    .map(([k, f]) => `<option value="${k}">${f.label}</option>`).join('');
  el.version.value = state.version;
  el.freq.value = state.freq;
  el.size.value = state.markerSize;
  el.sizeOut.textContent = state.markerSize;

  el.version.addEventListener('change', () => {
    state.version = el.version.value;
    if (state.rows[state.freq]) render();
  });
  el.freq.addEventListener('change', () => {
    state.freq = el.freq.value;
    loadAndRender();
  });
  el.start.addEventListener('change', () => {
    state.start = el.start.value;
    if (applyDateRules()) render();
  });
  el.end.addEventListener('change', () => {
    state.end = el.end.value;
    state.endAuto = !el.end.value;
    if (applyDateRules()) render();
  });
  el.size.addEventListener('input', () => {
    state.markerSize = Number(el.size.value);
    el.sizeOut.textContent = state.markerSize;
    setTrajectoryMarkerSize(el.chartTraj, state.markerSize);
  });
  el.reload.addEventListener('click', () => loadAndRender({ refresh: true }));

  let t;
  window.addEventListener('resize', () => {
    clearTimeout(t);
    t = setTimeout(() => { if (state.rows[state.freq]) render(); }, 250);
  });
}

// ------------------------------------------------------------ 시작
if (typeof Plotly === 'undefined') {
  showNotice('error', '<p><strong>그래프 라이브러리(Plotly)를 불러오지 못했습니다.</strong> 데이터 문제는 아니며, 페이지를 새로고침해 보세요.</p>');
} else {
  bindControls();
  updateMeta();
  loadAndRender();
}

// 개발자 도구에서 상태 확인용
window.__creditCycle = { state, currentPoints };
