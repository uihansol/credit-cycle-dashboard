// ============================================================
// app.js — 상태 관리 + UI 연결 (진입점)
// ============================================================
import {
  FREQUENCIES, VERSIONS, Y_AXES, REQUIRED_KEYS, OPTIONAL_KEYS, RECESSION_FILE, FORECAST, MAP_DEFAULTS,
  DEFAULT_FREQ, DEFAULT_VERSION, DEFAULT_MARKER_SIZE, DEFAULT_Y_AXIS,
} from './config.js';
import { loadSeries, loadMeta, DataLoadError, skippedSeries } from './data-loader.js';
import {
  alignSeries, aggregateAnnualMean, aggregateWeeklyMean, filterByDate, computePoints,
  formatDateLabel, computeRecessionPeriods, computeSpeeds, toAxisDate, addSteps, median, spliceWithOffset,
} from './transform.js';
import {
  PHASES, PHASE_ORDER, stepsFor, spliceProxyHistory, findAnalogs, projectFromAnalogs,
  summarizeProjection, diagnose, recessionWithin,
} from './forecast.js';
import {
  renderTimeSeries, renderTrajectory, renderCycleMap, setTrajectoryMarkerSize, clearChart, COLORS,
} from './charts.js';
import { buildOverlays } from './overlays.js';

// ------------------------------------------------------------ 상태
const state = {
  version: DEFAULT_VERSION,
  yAxis: DEFAULT_Y_AXIS,   // 'ratio' | 'spread'
  freq: DEFAULT_FREQ,
  start: FREQUENCIES[DEFAULT_FREQ].minDate,
  end: '',
  endAuto: true,          // 사용자가 종료일을 직접 바꾸기 전까지 최신일을 따라감
  rangeYears: null,       // 눌린 빠른 기간 버튼 (null=전체, 'custom'=직접 입력)
  markerSize: DEFAULT_MARKER_SIZE,
  colorMode: 'time',       // 'time' | 'speed' — 궤적 점 색상 기준
  horizon: FORECAST.defaultHorizon, // 전망 기간(개월)
  highlightAnalog: null,   // 강조할 유사 시점 날짜
  zoomCurrent: false,      // 궤적을 최근 3년 + 전망 경로 범위로 확대
  tab: 'map',              // 'map' | 'trajectory' | 'series' — 보이는 탭만 그린다 (기본: 사이클 맵)
  map: { ...MAP_DEFAULTS }, // 사이클 맵 탭 옵션 (로그·원 크기·표시). 세로축은 공통 state.yAxis 를 쓴다
  rows: {},                // freq → 정렬된 원자료 행
  latest: {},              // freq → 마지막 관측 날짜 (YYYY-MM-DD)
  splices: {},             // freq → 버전 → 이어 붙인 정보 {offset, overlap, realStart}
  recessionPeriods: null,  // USREC에서 뽑은 [{start,end}] (빈도와 무관, 한 번만 로드)
  features: { recession: true, phases: true, events: false, arrows: false, recent: true, forecast: true },
};

const RANGE_BUTTONS = [
  { label: '1년', years: 1 }, { label: '3년', years: 3 }, { label: '5년', years: 5 },
  { label: '10년', years: 10 }, { label: '20년', years: 20 }, { label: '전체', years: null },
];

// ------------------------------------------------------------ DOM
const $ = (id) => document.getElementById(id);
const el = {
  versionSeg: $('version-seg'), yAxisSeg: $('yaxis-seg'), freqSeg: $('freq-seg'), horizonSeg: $('horizon-seg'),
  start: $('start'), end: $('end'),
  size: $('marker-size'), sizeOut: $('marker-size-out'), reload: $('reload'), play: $('play'), zoom: $('zoom-current'),
  notice: $('notice'), status: $('status'), versionNote: $('version-note'),
  xTitle: $('x-chart-sub'), yTitle: $('y-chart-sub'), chartX: $('chart-x'), chartY: $('chart-y'),
  chartTraj: $('chart-trajectory'), trajSub: $('trajectory-sub'),
  diagnosis: $('diagnosis'), forecastBody: $('forecast-body'),
  meta: $('data-meta'), fresh: $('data-fresh'), rangeButtons: $('range-buttons'),
  optRecession: $('opt-recession'), optPhases: $('opt-phases'), optEvents: $('opt-events'),
  optArrows: $('opt-arrows'), optRecent: $('opt-recent'), optForecast: $('opt-forecast'),
  colorMode: $('color-mode'),
  tabs: document.querySelectorAll('[role="tab"][data-tab]'),
  chartMap: $('chart-map'), chartVix: $('chart-vix'), mapSub: $('map-sub'), mapVixNow: $('map-vix-now'),
  mapSizeSeg: $('map-size-seg'), mapHint: $('map-hint'), viewTitle: $('view-title'), sizeLabel: $('size-label'),
  viewGroups: document.querySelectorAll('[data-tabs]'),
  mapLogX: $('map-logx'), mapLogY: $('map-logy'), mapLine: $('map-line'), mapLabels: $('map-labels'), mapCycle: $('map-cycle'),
};
const ALL_CHARTS = () => [el.chartX, el.chartY, el.chartTraj, el.chartMap, el.chartVix];

// ------------------------------------------------------------ 알림
function showNotice(kind, html, tag = '') {
  el.notice.dataset.tag = tag; // 'nodata' 등 — 상황이 바뀌면 render()가 스스로 지울 수 있게 표식
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

// ------------------------------------------------------------ 숫자 표시
const fmt = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const signed = (v, d) => {
  if (!Number.isFinite(v)) return '—';
  const r = Number(v.toFixed(d));
  return `${r > 0 ? '+' : r < 0 ? '−' : '±'}${Math.abs(r).toFixed(d)}`;
};
const pct = (p) => (Number.isFinite(p) ? `${Math.round(p * 100)}%` : '—');
const horizonLabel = (months) => (months % 12 === 0 ? `${months / 12}년` : `${months}개월`);

// ------------------------------------------------------------ 데이터
async function ensureRows(freq, { refresh = false } = {}) {
  if (!refresh && state.rows[freq]) return state.rows[freq];
  const cfg = FREQUENCIES[freq];
  const maps = await loadSeries(cfg.files, { refresh, optional: OPTIONAL_KEYS });
  let rows = alignSeries(maps, REQUIRED_KEYS).filter((r) => r.date >= cfg.minDate);
  state.latest[freq] = rows.length ? rows[rows.length - 1].date : '';
  // 공개 기간이 짧은 지표는 같은 등급대의 장기 지표로 앞쪽을 이어 붙인다 (예: V7 BBB ← Moody's Baa).
  // 집계(주·연) 전 원자료에서 이어 붙여야 연간처럼 행이 적은 빈도에서도 겹치는 구간이 충분하다.
  state.splices[freq] = {};
  const keys = Object.keys(cfg.files);
  for (const [vk, v] of Object.entries(VERSIONS)) {
    if (!v.splice) continue;
    state.splices[freq][vk] = spliceWithOffset(rows, v.splice.key, v.splice.proxy, v.splice.out);
    keys.push(v.splice.out);
  }
  if (cfg.aggregate === 'annualMean') rows = aggregateAnnualMean(rows, keys);
  if (cfg.aggregate === 'weeklyMean') rows = aggregateWeeklyMean(rows, keys);
  state.rows[freq] = rows;
  analysisCache.clear();
  return rows;
}

/** 경기침체(USREC) 구간은 빈도와 무관하게 한 번만 불러와 캐시한다. */
async function ensureRecessionPeriods({ refresh = false } = {}) {
  if (!refresh && state.recessionPeriods) return state.recessionPeriods;
  try {
    const maps = await loadSeries(RECESSION_FILE, { refresh });
    const rows = alignSeries(maps, ['USREC']);
    state.recessionPeriods = computeRecessionPeriods(rows);
  } catch (e) {
    console.warn('경기침체 데이터를 불러오지 못했습니다:', e);
    state.recessionPeriods = [];
  }
  return state.recessionPeriods;
}

// ------------------------------------------------------------ 분석용 이력 (기간 필터와 무관한 전체 이력)
const analysisCache = new Map();

/**
 * 선택한 버전·세로축·빈도의 전체 이력. 버전에 proxy가 있고 자체 이력이 15년 미만이면
 * proxy 버전의 장기 이력을 환산해 앞에 붙인다 (전망·백분위 계산용, 그래프에는 실제 값만 표시).
 */
function analysisHistory() {
  const key = `${state.version}|${state.yAxis}|${state.freq}`;
  if (analysisCache.has(key)) return analysisCache.get(key);
  const v = VERSIONS[state.version];
  const y = Y_AXES[state.yAxis];
  const fcfg = FREQUENCIES[state.freq];
  const rows = state.rows[state.freq] || [];
  const own = computePoints(rows, v, y);
  let points = own, fit = null;
  const spanYears = own.length ? (Date.parse(toAxisDate(own[own.length - 1].date)) - Date.parse(toAxisDate(own[0].date))) / 3.156e10 : 0;
  if (v.proxy && VERSIONS[v.proxy] && spanYears < 15) {
    const proxy = computePoints(rows, VERSIONS[v.proxy], y);
    const res = spliceProxyHistory(own, proxy, { mode: v.deltaMode, minOverlap: Math.max(3, stepsFor(fcfg, 12)) });
    points = res.points; fit = res.fit;
  }
  const out = { points, fit, xSplit: median(points.map((p) => p.x)), ownStart: own[0]?.date };
  analysisCache.set(key, out);
  return out;
}

/** 날짜 이하 마지막 인덱스 (이진 탐색) */
function indexAtOrBefore(points, date) {
  let lo = 0, hi = points.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].date <= date) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function horizonsFor(freq) {
  return freq === 'annual' ? [12, 24, 36] : FORECAST.horizons;
}

/** 현재 기준 시점(표시 구간의 마지막 점)에서 유사 국면 전망을 계산한다. */
function computeForecast(hist, currentDate) {
  const v = VERSIONS[state.version];
  const y = Y_AXES[state.yAxis];
  const fcfg = FREQUENCIES[state.freq];
  const ci = indexAtOrBefore(hist.points, currentDate);
  if (ci < 0) return { ci, analogs: [], proj: null, summary: null };
  const H = stepsFor(fcfg, state.horizon);
  const L = stepsFor(fcfg, FORECAST.lookbackMonths);
  const analogs = findAnalogs(hist.points, ci, {
    horizon: H, lookback: L, separation: stepsFor(fcfg, FORECAST.separationMonths),
    count: FORECAST.analogs, momentumWeight: FORECAST.momentumWeight,
    modeX: v.deltaMode, modeY: y.deltaMode,
  });
  const proj = projectFromAnalogs(hist.points, ci, analogs, { horizon: H, modeX: v.deltaMode, modeY: y.deltaMode });
  const summary = summarizeProjection(proj, {
    xSplit: hist.xSplit, yInversion: y.inversion, periods: state.recessionPeriods || [],
    horizonMonths: state.horizon, history: hist.points, currentIndex: ci, horizonSteps: H,
  });
  return { ci, H, L, analogs, proj, summary };
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
  if (latest && state.end > latest) state.end = latest;
  // 빠른 기간 버튼이 눌린 상태면 빈도·종료일이 바뀌어도 그 의미(전체 / 최근 N년)를 유지한다.
  if (state.rangeYears !== 'custom') state.start = startForRange(state.rangeYears);

  const notes = [];
  if (!state.start || state.start < cfg.minDate) {
    if (state.start && state.rangeYears === 'custom') {
      notes.push(`${cfg.label}간 자료는 ${cfg.minDate} 이후부터 이용할 수 있습니다. 시작일을 ${cfg.minDate}로 조정했습니다.`);
    }
    state.start = cfg.minDate;
  }
  el.start.value = state.start;
  el.end.value = state.end;
  syncRangeButtons();

  if (state.end && state.start > state.end) {
    showNotice('error', '<p>시작일이 종료일보다 늦습니다. 날짜를 다시 선택해 주세요.</p>');
    return false;
  }
  if (notes.length) showNotice('info', `<p>${notes.join('<br>')}</p>`);
  else clearNotice();
  return true;
}

/** 빠른 기간(최근 N년 / 전체)에 해당하는 시작일. 기준은 종료일(없으면 최신일). */
function startForRange(years) {
  const cfg = FREQUENCIES[state.freq];
  const anchor = state.end || state.latest[state.freq];
  if (years === null || !anchor) return cfg.minDate;
  const [y, m, d] = anchor.split('-').map(Number);
  const iso = new Date(Date.UTC(y - years, m - 1, d)).toISOString().slice(0, 10);
  return iso < cfg.minDate ? cfg.minDate : iso;
}

/** 기간 단축 버튼: 최근 N년 / 전체. 종료일(기준 시점)은 유지한다. */
function applyQuickRange(years) {
  if (!state.latest[state.freq]) return;
  state.rangeYears = years;
  if (applyDateRules()) render();
}

function syncRangeButtons() {
  el.rangeButtons.querySelectorAll('button').forEach((b) => {
    const y = b.dataset.years === '' ? null : Number(b.dataset.years);
    b.setAttribute('aria-pressed', String(state.rangeYears === y));
  });
}

// ------------------------------------------------------------ 렌더링
function currentPoints() {
  const rows = filterByDate(state.rows[state.freq] || [], state.start, state.end);
  return computePoints(rows, VERSIONS[state.version], Y_AXES[state.yAxis]);
}

function render() {
  stopPlay({ silent: true });
  syncOptionUi();
  // 이전 렌더링의 "데이터 없음" 안내는 버전·빈도가 바뀌면 더 이상 맞지 않으므로 여기서 지운다.
  if (el.notice.dataset.tag === 'nodata') clearNotice();
  const v = VERSIONS[state.version];
  const y = Y_AXES[state.yAxis];
  const fcfg = FREQUENCIES[state.freq];
  const points = currentPoints();

  el.xTitle.textContent = v.xLabel;
  el.yTitle.textContent = y.label;
  el.trajSub.textContent = `가로 ${v.xShort} × 세로 ${y.short} · ${fcfg.label}간 자료 · 날짜순 연결`;
  const hist = state.rows[state.freq] ? analysisHistory() : null;
  const notes = [];
  if (v.note) notes.push(v.note);
  const sp = state.splices[state.freq]?.[state.version];
  if (sp?.offset !== null && sp?.offset !== undefined && sp.realStart) {
    notes.push(`${formatDateLabel(sp.realStart, state.freq)} 이전은 ${v.splice.proxyLabel} − ${sp.offset.toFixed(2)}%p로 환산한 값입니다 (겹치는 ${sp.overlap}개 관측치의 중앙값 차이).`);
  }
  if (hist?.fit) {
    notes.push(`전망·백분위 계산에는 ${formatDateLabel(hist.ownStart, state.freq)} 이전 구간을 ${VERSIONS[v.proxy].xShort} 장기 이력으로 환산해 씁니다 (겹치는 ${hist.fit.n}개 관측치 회귀, R² ${hist.fit.r2.toFixed(2)}${hist.fit.r2 < 0.5 ? ' — 겹치는 기간의 관계가 약해 전망은 방향 참고용으로만 보세요' : ''}).`);
  }
  el.versionNote.textContent = notes.join(' ');
  el.versionNote.hidden = !notes.length;

  if (!points.length) {
    ALL_CHARTS().forEach(clearChart);
    el.diagnosis.innerHTML = '';
    el.forecastBody.innerHTML = '<p class="empty">표시할 관측치가 없습니다.</p>';
    if (v.needs && skippedSeries.has(v.needs)) {
      showNotice('info', `<p><strong>${v.xShort} 데이터가 아직 저장소에 없습니다.</strong> GitHub Actions의 “Update FRED data”를 한 번 실행하면 받아옵니다. FRED가 이 시리즈를 공개하지 않는 경우에는 받아오지 못할 수 있습니다.</p><p>(${escapeHtml(String(skippedSeries.get(v.needs)))})</p>`, 'nodata');
    } else {
      showNotice('info', `<p>선택한 기간에는 ${v.xShort}·${y.short} 지표가 모두 있는 관측치가 없습니다. 기간을 넓혀 보세요.</p>`);
    }
    return;
  }

  const last = points[points.length - 1];
  const fc = computeForecast(hist, last.date);
  const diag = fc.ci >= 0 ? diagnose(hist.points, fc.ci, {
    xSplit: hist.xSplit, yInversion: y.inversion, stepsPerMonth: fcfg.stepsPerMonth,
  }) : null;

  // --- 시계열 (전망 부채꼴 포함)
  const recessions = state.features.recession ? (state.recessionPeriods || []) : [];
  const visibleRecessions = recessions
    .map((p) => ({ start: toAxisDate(p.start), end: toAxisDate(p.end) }))
    .filter((p) => p.end >= toAxisDate(points[0].date) && p.start <= toAxisDate(last.date));
  const showFc = state.features.forecast && fc.proj;
  const fanDates = showFc ? fc.proj.mean.map((_, s) => toAxisDate(s === 0 ? last.date : addSteps(last.date, state.freq, s))) : [];
  const fanLabels = showFc ? fc.proj.mean.map((_, s) => formatDateLabel(s === 0 ? last.date : addSteps(last.date, state.freq, s), state.freq)) : [];
  const fan = (axis) => (showFc ? {
    dates: fanDates, labels: fanLabels,
    mean: fc.proj.mean.map((q) => q[axis]),
    q10: fc.proj.bands.q10[axis], q25: fc.proj.bands.q25[axis],
    q75: fc.proj.bands.q75[axis], q90: fc.proj.bands.q90[axis],
  } : null);

  // 보이는 탭의 그래프만 그린다 (숨긴 패널의 Plotly는 크기를 못 잡는다 → 탭 전환 시 다시 render)
  if (state.tab === 'series') {
    renderTimeSeries(el.chartX, points, {
      accessor: (p) => p.x, label: v.xShort, digits: v.digits, freq: state.freq, color: COLORS.xSeries,
      recessions: visibleRecessions, forecast: fan('x'),
    });
    renderTimeSeries(el.chartY, points, {
      accessor: (p) => p.y, label: y.short, digits: y.digits, freq: state.freq, color: COLORS.ySeries,
      recessions: visibleRecessions, forecast: fan('y'), refLine: y.inversion,
    });
    const vixPts = points.filter((p) => Number.isFinite(p.raw?.VIX));
    if (vixPts.length) {
      renderTimeSeries(el.chartVix, points, {
        accessor: (p) => (Number.isFinite(p.raw?.VIX) ? p.raw.VIX : null), label: 'VIX', digits: 1,
        freq: state.freq, color: '#6a3fb5', recessions: visibleRecessions,
      });
    } else clearChart(el.chartVix);
  }
  if (state.tab === 'trajectory') drawTrajectory(points, { hist, fc });
  if (state.tab === 'map') drawCycleMap(hist);
  renderDiagnosis(diag, hist, fc);
  renderForecastPanel(fc, hist, diag);
  writeHash();
}

/** 궤적 그래프 (재생 중에는 fixedRange + noForecast로 호출된다) */
function drawTrajectory(points, { hist, fc, fixedRange = null, noForecast = false }) {
  const v = VERSIONS[state.version];
  const y = Y_AXES[state.yAxis];
  const fcfg = FREQUENCIES[state.freq];
  const speeds = state.colorMode === 'speed' ? computeSpeeds(points) : null;
  const showProj = state.features.forecast && !noForecast && fc?.proj;
  const range = fixedRange || (state.zoomCurrent ? zoomRange(points, showProj ? fc.proj : null, fcfg) : null);
  const overlays = buildOverlays(points, {
    version: state.version, freq: state.freq,
    features: { ...state.features, forecast: state.features.forecast && !noForecast },
    xDigits: v.digits, yDigits: y.digits,
    xSplit: hist?.xSplit, yInversion: y.inversion,
    projection: fc?.proj, history: hist?.points, highlightAnalog: state.highlightAnalog,
    horizonLabel: horizonLabel(state.horizon),
    recentSteps: stepsFor(fcfg, Math.max(12, FORECAST.lookbackMonths)),
    recentLabel: state.freq === 'annual' ? '최근 흐름' : '최근 12개월 흐름',
    lookbackSteps: fc?.L,
  });
  renderTrajectory(el.chartTraj, points, {
    freq: state.freq, markerSize: state.markerSize,
    xLabel: v.xLabel, yLabel: y.label, xShort: v.xShort, yShort: y.short,
    xDigits: v.digits, yDigits: y.digits, yInversion: y.inversion,
    colorMode: state.colorMode, speeds,
    currentLabel: formatDateLabel(points[points.length - 1].date, state.freq),
    xRange: range?.x, yRange: range?.y,
  }, overlays);
}

/** "현재 부근 확대": 최근 36개월 궤적 + 전망 경로들을 모두 담는 범위 */
function zoomRange(points, proj, fcfg) {
  const recent = points.slice(-Math.max(3, stepsFor(fcfg, 36) + 1));
  const all = recent.concat(proj ? proj.paths.flatMap((p) => p.points) : []);
  const pad = (arr) => {
    const lo = Math.min(...arr), hi = Math.max(...arr);
    const p = (hi - lo) * 0.12 || Math.abs(hi) * 0.05 || 0.1;
    return [lo - p, hi + p];
  };
  return { x: pad(all.map((p) => p.x)), y: pad(all.map((p) => p.y)) };
}

// ------------------------------------------------------------ 사이클 맵
function drawCycleMap(hist) {
  const v = VERSIONS[state.version];
  const m = state.map;
  const y = Y_AXES[state.yAxis];
  const fcfg = FREQUENCIES[state.freq];
  const rows = filterByDate(state.rows[state.freq] || [], state.start, state.end);
  const points = computePoints(rows, v, y);
  el.mapSub.textContent = `가로 ${v.xShort} × 세로 ${y.short} · ${fcfg.label}간 자료 · 색 = 연도, 크기 = ${m.sizeMode === 'vix' ? 'VIX' : '고정'}`;
  if (!points.length) { clearChart(el.chartMap); return; }

  // 로그 스케일은 양수에서만 가능 — 음수가 섞이면 끄고 이유를 알려 준다
  const hints = [];
  const logX = m.logX && points.every((p) => p.x > 0);
  const logY = m.logY && points.every((p) => p.y > 0);
  if (m.logX && !logX) hints.push(`${v.xShort}에 0 이하 값이 있어 가로축 로그 스케일을 적용할 수 없습니다.`);
  if (m.logY && !logY) hints.push(`10Y−2Y 금리차는 역전 시 음수가 되어 세로축 로그 스케일을 쓸 수 없습니다 — 위 ‘세로축 · 금리 구조’를 10Y/2Y 비율로 바꾸면 로그로 볼 수 있습니다.`);
  const hasVix = points.some((p) => Number.isFinite(p.raw?.VIX));
  if (m.sizeMode === 'vix' && !hasVix) {
    hints.push(skippedSeries.has('VIX')
      ? 'VIX 데이터가 아직 저장소에 없어 원 크기를 고정으로 표시합니다 (GitHub Actions 업데이트 후 반영).'
      : '선택한 기간에는 VIX 값이 없어 원 크기를 고정으로 표시합니다.');
  }
  el.mapHint.textContent = hints.join(' ');
  el.mapHint.hidden = !hints.length;

  // 최신 VIX: 마지막 점에 없으면(휴장·발표 지연) 가까운 이전 값을 날짜와 함께 보여 준다
  let vixPt = null;
  for (let i = points.length - 1; i >= Math.max(0, points.length - 15); i--) {
    if (Number.isFinite(points[i].raw?.VIX)) { vixPt = points[i]; break; }
  }
  el.mapVixNow.hidden = !vixPt;
  if (vixPt) {
    const same = vixPt === points[points.length - 1];
    el.mapVixNow.textContent = `현재 VIX ${vixPt.raw.VIX.toFixed(1)}${same ? '' : ` (${formatDateLabel(vixPt.date, state.freq)})`}`;
  }

  renderCycleMap(el.chartMap, points, {
    freq: state.freq, xLabel: v.xLabel, yLabel: y.label, xShort: v.xShort, yShort: y.short,
    xDigits: v.digits, yDigits: y.digits, logX, logY,
    sizeMode: m.sizeMode === 'vix' && hasVix ? 'vix' : 'fixed', markerSize: state.markerSize + 2,
    showLine: m.line, showLabels: m.labels, showCycle: m.cycle,
    xSplit: hist?.xSplit, yInversion: y.inversion,
  });
}

// ------------------------------------------------------------ 탭
function setTab(tab, { focus = false } = {}) {
  if (!['map', 'trajectory', 'series'].includes(tab)) tab = 'map';
  state.tab = tab;
  el.tabs.forEach((b) => {
    const on = b.dataset.tab === tab;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
    document.getElementById(b.getAttribute('aria-controls')).hidden = !on;
    if (on && focus) b.focus();
  });
  syncOptionUi();
}

const TAB_TITLES = { map: '· 사이클 맵', trajectory: '· 궤적 · 전망', series: '· 시계열' };

/** 보고 있는 탭에 해당하는 표시 옵션만 보이게 하고, 지금 쓸 수 없는 옵션은 비활성화한다. */
function syncOptionUi() {
  el.viewGroups.forEach((g) => { g.hidden = !g.dataset.tabs.split(' ').includes(state.tab); });
  el.viewTitle.textContent = TAB_TITLES[state.tab] || '';
  // 세로축이 금리차(음수 가능)면 세로 로그는 불가 → 끄고 이유를 툴팁으로
  const noLogY = state.yAxis === 'spread';
  el.mapLogY.disabled = noLogY;
  el.mapLogY.checked = state.map.logY && !noLogY;
  $('map-logy-wrap').title = noLogY ? '10Y−2Y 금리차는 음수가 있어 로그 스케일을 쓸 수 없습니다 (10Y/2Y 비율에서 사용 가능)' : '';
  // 점 크기 슬라이더: 맵에서 원 크기가 VIX로 정해지는 동안은 의미가 없다
  const vixSize = state.tab === 'map' && state.map.sizeMode === 'vix';
  el.size.disabled = vixSize;
  el.size.title = vixSize ? '원 크기가 VIX로 정해지는 중입니다 — ‘원 크기’를 고정으로 바꾸면 조절할 수 있습니다' : '';
  el.sizeLabel.textContent = state.tab === 'map' ? '원 크기(고정일 때)' : '점 크기';
}

// ------------------------------------------------------------ 진단 카드
function deltaSpan(v, digits, { invertColor = false, neutral = false } = {}) {
  if (!Number.isFinite(v)) return '<span class="delta delta--flat">—</span>';
  const r = Number(v.toFixed(digits));
  const dir = r > 0 ? 'up' : r < 0 ? 'down' : 'flat';
  let cls = `delta--${dir}`;
  if (neutral && dir !== 'flat') cls = `delta--neutral-${dir}`;
  else if (invertColor && dir !== 'flat') cls = `delta--${dir === 'up' ? 'down' : 'up'}`;
  const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '■';
  return `<span class="delta ${cls}">${arrow} ${signed(v, digits)}</span>`;
}

function renderDiagnosis(diag, hist, fc) {
  if (!diag) { el.diagnosis.innerHTML = ''; return; }
  const v = VERSIONS[state.version];
  const y = Y_AXES[state.yAxis];
  const ph = PHASES[diag.phase];
  const cur = diag.current;
  const raw = cur.raw || {};
  const annual = state.freq === 'annual';
  const asOf = formatDateLabel(cur.date, state.freq) +
    (raw.months && raw.months < 12 ? ` (${raw.months}개월 평균)` : '') +
    (raw.days && raw.days < 5 ? ` (${raw.days}일 평균)` : '');

  const changes = (c, digits, opts) => {
    const parts = [];
    if (!annual && c.m3) parts.push(`<span class="nowrap">3개월 ${deltaSpan(c.m3, digits, opts)}</span>`);
    if (c.m12) parts.push(`<span class="nowrap">${annual ? '1년' : '12개월'} ${deltaSpan(c.m12, digits, opts)}</span>`);
    return parts.join('');
  };
  const pick = (k) => ({
    m3: diag.change.m3 ? diag.change.m3[k] : null,
    m12: diag.change.m12 ? diag.change.m12[k] : null,
  });

  const term = Number.isFinite(raw.GS10) && Number.isFinite(raw.GS2) ? raw.GS10 - raw.GS2 : NaN;
  const ratio = raw.GS2 > 0 ? raw.GS10 / raw.GS2 : NaN;
  const back12 = fc.ci >= 0 ? hist.points[fc.ci - Math.max(1, Math.round(12 * FREQUENCIES[state.freq].stepsPerMonth))] : null;
  const r12 = back12?.raw || {};
  const xPctText = Number.isFinite(diag.xPct)
    ? `${hist.points[0].date.slice(0, 4)}년 이후 이력 중 백분위 <b>${Math.round(diag.xPct)}</b>${hist.fit ? ' (환산 이력 포함)' : ''}`
    : '';

  const rec = fc.summary?.recession;
  const recTile = rec
    ? `<div class="kpi">
        <span class="kpi__label">유사 국면 이후 ${horizonLabel(state.horizon)} 내 침체 동반</span>
        <span class="kpi__value">${pct(rec.probability)}</span>
        <span class="kpi__sub">평소(전체 이력) ${pct(rec.base)} · 유사 시점 ${fc.analogs.length}개 기준</span>
        <span class="kpi__deltas">NBER 경기침체 판정 기준, 참고용</span>
      </div>`
    : `<div class="kpi"><span class="kpi__label">침체 동반 비율</span><span class="kpi__value">—</span><span class="kpi__sub">유사 시점을 찾을 이력이 부족합니다.</span></div>`;

  el.diagnosis.innerHTML = `
    <article class="panel phase-card" style="--phase-color:${ph.color}">
      <div class="phase-card__top">
        <span class="phase-badge">현재 국면 · ${ph.full}</span>
        <span class="phase-card__asof">기준 ${asOf}</span>
      </div>
      <h3>${diag.flow.title}</h3>
      <p>${ph.desc}.</p>
      <div class="phase-card__flow">
        <strong>최근 ${diag.flow.months >= 12 ? '1년' : `${diag.flow.months}개월`} 흐름</strong>
        <p>${diag.flow.text}</p>
      </div>
      ${diag.signals.length ? `<ul class="signals">${diag.signals.map((s) => `<li class="${s.level}">${s.text}</li>`).join('')}</ul>` : ''}
    </article>
    <div class="kpis">
      <div class="kpi">
        <span class="kpi__label">신용스프레드 · ${v.xShort}</span>
        <span class="kpi__value">${fmt(cur.x, v.digits)}<small>${v.unit || ''}</small></span>
        <span class="kpi__deltas">${changes(pick('x'), v.digits)}</span>
        <div class="meter" aria-hidden="true"><span class="meter__mark" style="left:${Math.min(100, Math.max(0, diag.xPct || 0))}%"></span></div>
        <div class="meter__labels"><span>좁음(위험선호)</span><span>넓음(스트레스)</span></div>
        <span class="kpi__sub">${xPctText}</span>
      </div>
      <div class="kpi">
        <span class="kpi__label">장단기 금리차 · 10Y−2Y</span>
        <span class="kpi__value">${signed(term, 2)}<small>%p</small></span>
        <span class="kpi__deltas">${changes(pick('y'), y.digits, { neutral: true })}</span>
        <span class="kpi__sub">10Y/2Y 비율 ${fmt(ratio, 3)} · ${diag.inverted ? '<b>역전 상태</b>' : '정상 커브'}</span>
        <span class="kpi__sub">변화는 세로축(${y.short}) 기준 · ▲ 가팔라짐 ▼ 평탄화</span>
      </div>
      <div class="kpi">
        <span class="kpi__label">국채 금리 수준</span>
        <span class="kpi__value">${fmt(raw.GS2, 2)}<small>% 2Y</small></span>
        <span class="kpi__sub">10년물 ${fmt(raw.GS10, 2)}%</span>
        <span class="kpi__deltas"><span class="nowrap">${annual ? '1년' : '12개월'} 2Y ${deltaSpan(raw.GS2 - r12.GS2, 2, { neutral: true })}</span><span class="nowrap">10Y ${deltaSpan(raw.GS10 - r12.GS10, 2, { neutral: true })}</span></span>
        <span class="kpi__sub">2년물 하락 = 정책금리 인하 기대</span>
      </div>
      ${recTile}
    </div>`;
}

// ------------------------------------------------------------ 전망 패널
function renderForecastPanel(fc, hist, diag) {
  const v = VERSIONS[state.version];
  const y = Y_AXES[state.yAxis];
  const hl = horizonLabel(state.horizon);
  const s = fc.summary;
  if (!s || !fc.proj) {
    el.forecastBody.innerHTML = '<p class="empty">기준 시점 이전 이력이 짧아 비슷한 과거 시점을 찾지 못했습니다. 기간 종료일을 늦추거나 다른 버전을 골라 보세요.</p>';
    return;
  }
  const top = PHASE_ORDER.map((k) => [k, s.probs[k]]).sort((a, b) => b[1] - a[1])[0];
  const cur = fc.proj.current;
  const headline = `
    <div class="fc-headline">
      <p>${hl} 뒤 가장 가능성 높은 국면: <b style="color:${PHASES[top[0]].text}">${PHASES[top[0]].full} (${pct(top[1])})</b></p>
      <p>예상: ${v.xShort} ${fmt(cur.x, v.digits)} → <b>${fmt(s.expected.x, v.digits)}</b>,
         ${y.short} ${fmt(cur.y, y.digits)} → <b>${fmt(s.expected.y, y.digits)}</b></p>
    </div>`;

  const probs = `
    <section>
      <h3>${hl} 뒤 국면별 가능성</h3>
      <ul class="prob-list">
        ${PHASE_ORDER.map((k) => `
          <li class="prob${diag && diag.phase === k ? ' is-current' : ''}" style="--c:${PHASES[k].color}">
            <span class="prob__name"><span class="prob__swatch"></span>${PHASES[k].label}</span>
            <span class="prob__bar"><span class="prob__fill" style="width:${Math.round(s.probs[k] * 100)}%"></span></span>
            <span class="prob__val">${pct(s.probs[k])}</span>
          </li>`).join('')}
      </ul>
    </section>`;

  const rec = s.recession;
  const stats = `
    <section>
      <h3>방향 가능성</h3>
      <div class="fc-stats">
        <div class="fc-stat"><span class="fc-stat__label">스프레드 확대</span><span class="fc-stat__value">${pct(s.pWiden)}</span><span class="fc-stat__sub">예상 ${signed(s.expected.dx, v.digits)}${v.unit || ''}</span></div>
        <div class="fc-stat"><span class="fc-stat__label">커브 가팔라짐</span><span class="fc-stat__value">${pct(s.pSteepen)}</span><span class="fc-stat__sub">예상 ${signed(s.expected.dy, y.digits)}</span></div>
        ${rec ? `<div class="fc-stat"><span class="fc-stat__label">침체 동반</span><span class="fc-stat__value">${pct(rec.probability)}</span><span class="fc-stat__sub">평소 ${pct(rec.base)}</span></div>` : ''}
        <div class="fc-stat"><span class="fc-stat__label">예상 국면 이동</span><span class="fc-stat__value" style="font-size:0.92rem">${PHASES[s.fromPhase].label} → ${PHASES[s.toPhase].label}</span><span class="fc-stat__sub">평균 경로 끝점 기준</span></div>
      </div>
    </section>`;

  const H = fc.proj.horizon;
  const analogItems = fc.proj.paths
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .map((p) => {
      const a = p.analog;
      const h0 = hist.points[a.index], h1 = hist.points[a.index + H];
      const recHit = (state.recessionPeriods || []).length && recessionWithin(a.date, state.horizon, state.recessionPeriods);
      const pressed = state.highlightAnalog === a.date;
      return `<li><button type="button" class="analog" data-date="${a.date}" aria-pressed="${pressed}">
        <span class="analog__date">${formatDateLabel(a.date, state.freq)}${h0.proxied ? ' <small>(환산)</small>' : ''}</span>
        <span class="analog__sim">가중치 ${pct(p.weight)}</span>
        <span class="analog__after">이후 ${hl}: ${v.xShort} ${signed(h1.x - h0.x, v.digits)}, ${y.short} ${signed(h1.y - h0.y, y.digits)}${recHit ? ' · <span class="analog__rec">침체 동반</span>' : ''}</span>
      </button></li>`;
    }).join('');

  const since = hist.points[0] ? formatDateLabel(hist.points[0].date, state.freq) : '';
  el.forecastBody.innerHTML = `
    ${headline}
    ${probs}
    ${stats}
    <section>
      <h3>가장 비슷했던 과거 시점 (눌러서 그때 궤적 보기)</h3>
      <ul class="analogs">${analogItems}</ul>
    </section>
    <p class="fc-note">${since}부터의 이력에서 위치·최근 ${FORECAST.lookbackMonths}개월 흐름이 비슷한 시점 ${fc.analogs.length}개를 골라 이후 경로를 현재에 옮겨 붙였습니다. 참고용 시나리오이며 예측을 보장하지 않습니다.</p>`;
}

// ------------------------------------------------------------ 흐름 재생
let playTimer = null;

function startPlay() {
  const points = currentPoints();
  if (points.length < 3) return;
  const hist = analysisHistory();
  const pad = (arr) => {
    const lo = Math.min(...arr), hi = Math.max(...arr);
    const p = (hi - lo) * 0.06 || 0.1;
    return [lo - p, hi + p];
  };
  const range = { x: pad(points.map((p) => p.x)), y: pad(points.map((p) => p.y)) };
  const frames = Math.min(points.length, 150);
  let f = 1;
  el.play.textContent = '❚❚ 멈춤';
  el.play.setAttribute('aria-pressed', 'true');
  playTimer = setInterval(() => {
    const n = Math.max(2, Math.round((points.length * f) / frames));
    drawTrajectory(points.slice(0, n), { hist, fc: null, fixedRange: range, noForecast: true });
    f += 1;
    if (f > frames) stopPlay();
  }, 70);
}

function stopPlay({ silent = false } = {}) {
  if (!playTimer) return;
  clearInterval(playTimer);
  playTimer = null;
  el.play.textContent = '▶ 흐름 재생';
  el.play.setAttribute('aria-pressed', 'false');
  if (!silent) render();
}

// ------------------------------------------------------------ 주소(해시)에 선택 상태 저장 → 링크 공유
function writeHash() {
  const p = new URLSearchParams();
  p.set('v', state.version); p.set('y', state.yAxis); p.set('f', state.freq); p.set('h', String(state.horizon));
  if (state.start !== FREQUENCIES[state.freq].minDate) p.set('s', state.start);
  if (!state.endAuto && state.end) p.set('e', state.end);
  if (state.tab !== 'map') p.set('t', state.tab);
  const next = `#${p.toString()}`;
  if (location.hash !== next) history.replaceState(null, '', next);
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (VERSIONS[p.get('v')]) state.version = p.get('v');
  if (Y_AXES[p.get('y')]) state.yAxis = p.get('y');
  if (FREQUENCIES[p.get('f')]) state.freq = p.get('f');
  if (p.get('t')) state.tab = p.get('t');
  const h = Number(p.get('h'));
  if (horizonsFor(state.freq).includes(h)) state.horizon = h;
  const re = /^\d{4}-\d{2}-\d{2}$/;
  state.start = FREQUENCIES[state.freq].minDate;
  if (re.test(p.get('s') || '')) { state.start = p.get('s'); state.rangeYears = 'custom'; }
  if (re.test(p.get('e') || '')) { state.end = p.get('e'); state.endAuto = false; state.rangeYears = 'custom'; }
}

// ------------------------------------------------------------ 흐름
async function loadAndRender({ refresh = false } = {}) {
  el.reload.disabled = true;
  setStatus(refresh ? '저장된 CSV를 다시 읽는 중…' : '저장된 CSV를 읽는 중…');
  try {
    if (refresh) { state.rows = {}; state.recessionPeriods = null; analysisCache.clear(); }
    await Promise.all([ensureRows(state.freq, { refresh }), ensureRecessionPeriods({ refresh })]);
    if (applyDateRules()) render();
    setStatus('');
    if (refresh) updateMeta();
  } catch (err) {
    console.error(err);
    showLoadError(err);
    ALL_CHARTS().forEach(clearChart);
    el.diagnosis.innerHTML = '';
    el.forecastBody.innerHTML = '';
    setStatus('');
  } finally {
    el.reload.disabled = false;
  }
}

async function updateMeta() {
  const meta = await loadMeta();
  if (!meta) {
    el.meta.textContent = '데이터 출처: FRED (저장소에 보관된 CSV)';
    el.fresh.textContent = 'FRED';
    return;
  }
  const when = new Date(meta.updated_at);
  const whenText = Number.isNaN(when.getTime()) ? meta.updated_at
    : when.toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
  const m = meta.series?.BAA?.last, d = meta.series?.DBAA?.last;
  el.meta.textContent = `데이터 출처: FRED · 저장소 CSV 마지막 갱신 ${whenText}` +
    (m ? ` · 월간 최신 ${m}` : '') + (d ? ` · 일간 최신 ${d}` : '');
  el.fresh.textContent = `FRED 일간 ${d || '—'} · 월간 ${m ? m.slice(0, 7) : '—'}`;
  el.fresh.title = `FRED 데이터의 마지막 관측일 (일간 ${d || '—'}, 월간 ${m ? m.slice(0, 7) : '—'}). 저장소 CSV 마지막 갱신: ${whenText}`;
}

/** 세그먼트(라디오 버튼 묶음) 만들기 */
function buildSeg(container, items, current, onPick) {
  container.innerHTML = items
    .map(([value, label, sub]) => `<button type="button" role="radio" data-value="${value}" aria-checked="${value === current}">${label}${sub ? `<small>${sub}</small>` : ''}</button>`)
    .join('');
  container.onclick = (ev) => {
    const b = ev.target.closest('button[data-value]');
    if (!b) return;
    container.querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    onPick(b.dataset.value);
  };
  // 화살표 키로 이동
  container.onkeydown = (ev) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(ev.key)) return;
    const btns = [...container.querySelectorAll('button')];
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    const next = btns[(i + (ev.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length];
    next.focus();
    next.click();
    ev.preventDefault();
  };
}

function buildHorizonSeg() {
  const list = horizonsFor(state.freq);
  if (!list.includes(state.horizon)) state.horizon = list.includes(FORECAST.defaultHorizon) ? FORECAST.defaultHorizon : list[0];
  buildSeg(el.horizonSeg, list.map((m) => [String(m), horizonLabel(m)]), String(state.horizon), (val) => {
    state.horizon = Number(val);
    state.highlightAnalog = null;
    if (state.rows[state.freq]) render();
  });
}

function bindControls() {
  buildSeg(el.versionSeg, Object.entries(VERSIONS).map(([k, v]) => [k, v.menu, k]), state.version, (val) => {
    state.version = val;
    state.highlightAnalog = null;
    if (state.rows[state.freq]) render();
  });
  buildSeg(el.yAxisSeg, Object.entries(Y_AXES).map(([k, y]) => [k, y.menu]), state.yAxis, (val) => {
    state.yAxis = val;
    state.highlightAnalog = null;
    if (state.rows[state.freq]) render();
  });
  buildSeg(el.freqSeg, Object.entries(FREQUENCIES).map(([k, f]) => [k, f.label]), state.freq, (val) => {
    state.freq = val;
    state.highlightAnalog = null;
    buildHorizonSeg();
    loadAndRender();
  });
  buildHorizonSeg();

  el.size.value = state.markerSize;
  el.sizeOut.textContent = state.markerSize;
  el.optRecession.checked = state.features.recession;
  el.optPhases.checked = state.features.phases;
  el.optEvents.checked = state.features.events;
  el.optArrows.checked = state.features.arrows;
  el.optRecent.checked = state.features.recent;
  el.optForecast.checked = state.features.forecast;
  el.colorMode.value = state.colorMode;
  el.rangeButtons.innerHTML = RANGE_BUTTONS
    .map((r) => `<button type="button" class="chip" data-years="${r.years ?? ''}" aria-pressed="false">${r.label}</button>`).join('');

  el.start.addEventListener('change', () => {
    state.start = el.start.value;
    state.rangeYears = 'custom';
    if (applyDateRules()) render();
  });
  el.end.addEventListener('change', () => {
    state.end = el.end.value;
    state.endAuto = !el.end.value;
    state.rangeYears = 'custom';
    state.highlightAnalog = null;
    if (applyDateRules()) render();
  });
  el.size.addEventListener('input', () => {
    state.markerSize = Number(el.size.value);
    el.sizeOut.textContent = state.markerSize;
    if (state.tab === 'trajectory') setTrajectoryMarkerSize(el.chartTraj, state.markerSize);
    else if (state.tab === 'map' && state.map.sizeMode === 'fixed' && state.rows[state.freq]) render();
  });
  el.reload.addEventListener('click', () => loadAndRender({ refresh: true }));
  el.play.addEventListener('click', () => (playTimer ? stopPlay() : startPlay()));
  el.zoom.addEventListener('click', () => {
    state.zoomCurrent = !state.zoomCurrent;
    el.zoom.setAttribute('aria-pressed', String(state.zoomCurrent));
    if (state.rows[state.freq]) render();
  });
  el.rangeButtons.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-years]');
    if (!btn) return;
    applyQuickRange(btn.dataset.years === '' ? null : Number(btn.dataset.years));
  });
  const toggle = (input, key) => input.addEventListener('change', () => {
    state.features[key] = input.checked;
    if (state.rows[state.freq]) render();
  });
  toggle(el.optRecession, 'recession');
  toggle(el.optPhases, 'phases');
  toggle(el.optEvents, 'events');
  toggle(el.optArrows, 'arrows');
  toggle(el.optRecent, 'recent');
  toggle(el.optForecast, 'forecast');
  el.colorMode.addEventListener('change', () => { state.colorMode = el.colorMode.value; if (state.rows[state.freq]) render(); });

  // 탭: 클릭 + 좌우 화살표 키
  setTab(state.tab);
  el.tabs.forEach((b) => b.addEventListener('click', () => {
    setTab(b.dataset.tab);
    if (state.rows[state.freq]) render();
  }));
  el.tabs[0].parentElement.addEventListener('keydown', (ev) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(ev.key)) return;
    const list = [...el.tabs];
    const i = list.findIndex((b) => b.dataset.tab === state.tab);
    const next = list[(i + (ev.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length];
    setTab(next.dataset.tab, { focus: true });
    if (state.rows[state.freq]) render();
    ev.preventDefault();
  });

  // 사이클 맵 옵션 (세로축은 위쪽 공통 조건 '세로축 · 금리 구조'를 따른다)
  buildSeg(el.mapSizeSeg, [['vix', 'VIX'], ['fixed', '고정']], state.map.sizeMode, (val) => {
    state.map.sizeMode = val;
    if (state.rows[state.freq]) render();
  });
  const mapToggle = (input, key) => {
    input.checked = state.map[key];
    input.addEventListener('change', () => {
      state.map[key] = input.checked;
      if (state.rows[state.freq]) render();
    });
  };
  mapToggle(el.mapLogX, 'logX');
  mapToggle(el.mapLogY, 'logY');
  mapToggle(el.mapLine, 'line');
  mapToggle(el.mapLabels, 'labels');
  mapToggle(el.mapCycle, 'cycle');

  el.forecastBody.addEventListener('click', (ev) => {
    const b = ev.target.closest('button.analog');
    if (!b) return;
    state.highlightAnalog = state.highlightAnalog === b.dataset.date ? null : b.dataset.date;
    if (!state.features.forecast) { state.features.forecast = true; el.optForecast.checked = true; }
    render();
  });

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
  readHash();
  bindControls();
  updateMeta();
  loadAndRender();
}

// 개발자 도구에서 상태 확인용
window.__creditCycle = { state, currentPoints, analysisHistory, computeForecast };
