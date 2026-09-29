// ============================================================
// charts.js — Plotly 렌더링 (데이터 계산은 하지 않는다)
// ============================================================
import { formatDateLabel, toAxisDate } from './transform.js';

const GL_THRESHOLD = 4000; // 점이 많으면 WebGL(scattergl) 사용

const COLORS = {
  ink: '#1f2a37',
  muted: '#6b7785',
  grid: '#e9edf2',
  xSeries: '#b0342f',   // 신용스프레드 — 붉은 계열 (스트레스)
  ySeries: '#256abf',   // 장단기 금리 구조 — 푸른 계열
  path: 'rgba(60, 72, 88, 0.30)',
  forecast: '#6a3fb5',
};

// 과거(연함) → 최근(진함) — 단일 색상(파랑) 순차 팔레트
const TIME_SCALE = [
  [0, '#cde2fb'],
  [0.35, '#86b6ef'],
  [0.7, '#2a78d6'],
  [1, '#0d366b'],
];

const CURRENT_COLOR = '#c0392b';
const REF_LINE_COLOR = '#9aa5b1';
const RECESSION_COLOR = 'rgba(90, 90, 100, 0.12)';

// 이동 속도 색상(0=느림 → 1=빠름)
const SPEED_SCALE = [
  [0, '#eef1f4'],
  [0.5, '#e8a33d'],
  [1, '#b0242c'],
];

/** USREC 침체 구간을 시계열 그래프용 회색 배경 shape 배열로 변환한다. */
function recessionShapes(periods) {
  return (periods || []).map((p) => ({
    type: 'rect', xref: 'x', yref: 'paper', x0: p.start, x1: p.end, y0: 0, y1: 1,
    fillcolor: RECESSION_COLOR, line: { width: 0 }, layer: 'below',
  }));
}

/**
 * 색상 기준(시간/속도)에 따라 marker 설정을 만든다.
 * opts.colorMode: 'time'(기본) | 'speed'. speed일 때는 opts.speeds 배열 필요.
 */
function buildTrajectoryMarker(opts, idx, n, mobile, yearMarks, labels) {
  const base = {
    size: opts.markerSize,
    line: { width: 0.5, color: 'rgba(255,255,255,0.8)' },
    opacity: 0.9,
    showscale: !mobile && n >= 2,
  };
  if (opts.colorMode === 'speed' && opts.speeds && opts.speeds.length === n) {
    const maxSpeed = Math.max(...opts.speeds, 1e-9);
    return {
      ...base,
      color: opts.speeds,
      colorscale: SPEED_SCALE,
      cmin: 0,
      cmax: maxSpeed,
      colorbar: mobile || n < 2 ? undefined : {
        thickness: 10, len: 0.6, outlinewidth: 0,
        tickvals: [0, maxSpeed],
        ticktext: ['느림', '빠름'],
        tickfont: { size: 10, color: COLORS.muted },
      },
    };
  }
  return {
    ...base,
    color: idx,
    colorscale: TIME_SCALE,
    cmin: 0,
    cmax: Math.max(n - 1, 1),
    colorbar: mobile || n < 2 ? undefined : {
      thickness: 10, len: 0.75, outlinewidth: 0,
      tickvals: yearMarks.map((m) => m.index),
      ticktext: yearMarks.map((m) => `${m.year}년`),
      tickfont: { size: 10, color: COLORS.muted },
    },
  };
}

/**
 * 궤적 위에 표시할 "연도 라벨" 지점을 고른다.
 * 각 연도의 첫 관측치를 후보로 삼고, 라벨이 8~14개 정도가 되도록 걸러낸다.
 * @param {{date:string}[]} points
 * @returns {{index:number, year:string}[]}
 */
function pickYearMarks(points) {
  const firstOfYear = new Map(); // year → index
  points.forEach((p, i) => {
    const y = p.date.slice(0, 4);
    if (!firstOfYear.has(y)) firstOfYear.set(y, i);
  });
  const years = [...firstOfYear.keys()];
  const targetCount = 12;
  const step = Math.max(1, Math.ceil(years.length / targetCount));
  const marks = [];
  years.forEach((y, i) => {
    if (i % step === 0) marks.push({ index: firstOfYear.get(y), year: y });
  });
  // 마지막 연도가 걸러졌다면 다시 넣어 최신 시점까지 라벨이 이어지게 한다.
  const lastYear = years[years.length - 1];
  if (marks.length && marks[marks.length - 1].year !== lastYear) {
    marks.push({ index: firstOfYear.get(lastYear), year: lastYear });
  }
  return marks;
}

const BASE_CONFIG = {
  responsive: true,
  displaylogo: false,
  modeBarButtonsToRemove: ['lasso2d', 'select2d', 'autoScale2d', 'toggleSpikelines'],
};

function baseLayout(isMobile) {
  return {
    margin: { l: isMobile ? 46 : 58, r: 16, t: 8, b: isMobile ? 40 : 46 },
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { family: 'Pretendard, "Apple SD Gothic Neo", "Malgun Gothic", system-ui, sans-serif', size: 12, color: COLORS.ink },
    hoverlabel: { bgcolor: '#ffffff', bordercolor: '#cfd6de', font: { color: COLORS.ink, size: 12 } },
    xaxis: { gridcolor: COLORS.grid, zeroline: false, linecolor: '#cfd6de', ticks: 'outside', tickcolor: '#cfd6de' },
    yaxis: { gridcolor: COLORS.grid, zeroline: false, linecolor: '#cfd6de', ticks: 'outside', tickcolor: '#cfd6de' },
    showlegend: false,
    dragmode: 'zoom',
  };
}

const isMobile = () => window.matchMedia('(max-width: 640px)').matches;
const config = () => ({ ...BASE_CONFIG, displayModeBar: isMobile() ? false : 'hover' });

/**
 * 시간 변화 선 그래프 (상단 두 그래프 공용)
 * @param {HTMLElement} el
 * @param {{date:string}[]} points
 * @param {{accessor:(p)=>number, label:string, digits:number, color?:string, freq:string, recessions?:{start:string,end:string}[]}} opts
 */
export function renderTimeSeries(el, points, opts) {
  const mobile = isMobile();
  const traces = [];
  const trace = {
    type: points.length > GL_THRESHOLD ? 'scattergl' : 'scatter',
    mode: 'lines',
    x: points.map((p) => toAxisDate(p.date)),
    y: points.map(opts.accessor),
    customdata: points.map((p) => formatDateLabel(p.date, opts.freq)),
    line: { color: opts.color || COLORS.xSeries, width: 1.6 },
    hovertemplate: `%{customdata}<br>${opts.label}: %{y:.${opts.digits}f}<extra></extra>`,
    name: opts.label,
    showlegend: false,
  };
  traces.push(trace);

  // 전망 부채꼴(fan): 10–90% 밴드, 25–75% 밴드, 예상 경로(점선)
  const fc = opts.forecast;
  const shapes = recessionShapes(opts.recessions);
  if (fc && fc.dates.length > 1) {
    const band = (lo, hi, fill, name) => [
      { type: 'scatter', mode: 'lines', x: fc.dates, y: lo, line: { width: 0 }, hoverinfo: 'skip', showlegend: false },
      { type: 'scatter', mode: 'lines', x: fc.dates, y: hi, line: { width: 0 }, fill: 'tonexty', fillcolor: fill, name, hoverinfo: 'skip', showlegend: false },
    ];
    traces.push(...band(fc.q10, fc.q90, 'rgba(106, 63, 181, 0.10)', '10–90%'));
    traces.push(...band(fc.q25, fc.q75, 'rgba(106, 63, 181, 0.18)', '25–75%'));
    traces.push({
      type: 'scatter', mode: 'lines', x: fc.dates, y: fc.mean,
      line: { color: COLORS.forecast, width: 2, dash: 'dash' },
      customdata: fc.labels,
      hovertemplate: `예상 %{customdata}<br>${opts.label}: %{y:.${opts.digits}f}<extra></extra>`,
      showlegend: false,
    });
    // 전망 시작 지점 세로선
    shapes.push({
      type: 'line', xref: 'x', yref: 'paper', x0: fc.dates[0], x1: fc.dates[0], y0: 0, y1: 1,
      line: { color: 'rgba(106, 63, 181, 0.5)', width: 1, dash: 'dot' },
    });
  }
  if (Number.isFinite(opts.refLine)) {
    shapes.push({
      type: 'line', xref: 'paper', x0: 0, x1: 1, yref: 'y', y0: opts.refLine, y1: opts.refLine,
      line: { color: REF_LINE_COLOR, width: 1, dash: 'dash' },
    });
  }

  const layout = baseLayout(mobile);
  layout.xaxis = { ...layout.xaxis, type: 'date' };
  if (opts.xRange) layout.xaxis.range = opts.xRange;
  layout.yaxis = { ...layout.yaxis, title: { text: mobile ? '' : opts.label, font: { size: 11, color: COLORS.muted } } };
  layout.hovermode = 'x';
  layout.shapes = shapes;
  return Plotly.react(el, traces, layout, config());
}

/**
 * 금리·신용 사이클 궤적: 날짜순으로 점을 연결한다.
 * trace 0 = 연결선, trace 1 = 시간 색상 점, 이후 = overlays.traces
 * @param {{traces?:object[], shapes?:object[], annotations?:object[]}} [overlays] 향후 국면 영역·이벤트 표시용
 */
export function renderTrajectory(el, points, opts, overlays = {}) {
  const mobile = isMobile();
  const gl = points.length > GL_THRESHOLD;
  const type = gl ? 'scattergl' : 'scatter';
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const labels = points.map((p) => formatDateLabel(p.date, opts.freq));
  const idx = points.map((_, i) => i);
  const n = points.length;

  const path = {
    type, mode: 'lines', x: xs, y: ys,
    line: { color: COLORS.path, width: 1 },
    hoverinfo: 'skip',
    showlegend: false,
  };

  const yearMarks = pickYearMarks(points);
  // 연도 라벨 지점: 점을 살짝 키우고 진한 테두리를 둘러 궤적 점들과 구분한다.
  const yearDots = {
    type: 'scatter', mode: mobile ? 'markers' : 'markers+text',
    x: yearMarks.map((m) => xs[m.index]), y: yearMarks.map((m) => ys[m.index]),
    text: yearMarks.map((m) => `'${m.year.slice(2)}`),
    textposition: 'top right',
    textfont: { size: 10, color: '#52606d' },
    marker: { size: Math.max(opts.markerSize + 3, 9), color: 'rgba(0,0,0,0)', line: { width: 1.6, color: COLORS.ink } },
    hoverinfo: 'skip',
    showlegend: false,
  };

  const dots = {
    type, mode: 'markers', x: xs, y: ys,
    customdata: labels,
    marker: buildTrajectoryMarker(opts, idx, n, mobile, yearMarks, labels),
    hovertemplate:
      `%{customdata}<br>X (${opts.xShort}): %{x:.${opts.xDigits}f}` +
      `<br>Y (${opts.yShort}): %{y:.${opts.yDigits}f}<extra></extra>`,
    showlegend: false,
  };

  // 가장 최근 시점: 큰 점으로 강조해 "지금 위치"를 바로 찾을 수 있게 한다.
  const current = {
    type: 'scatter', x: [xs[n - 1]], y: [ys[n - 1]],
    customdata: [labels[n - 1]],
    mode: 'markers+text',
    text: [mobile ? '' : `<b>${opts.currentLabel || '현재'}</b>`],
    textposition: 'top left',
    textfont: { size: 11, color: CURRENT_COLOR },
    marker: { size: Math.max(opts.markerSize + 7, 14), color: CURRENT_COLOR, line: { width: 2.5, color: '#ffffff' }, symbol: 'circle' },
    hovertemplate: `현재 (%{customdata})<br>X: %{x:.${opts.xDigits}f}<br>Y: %{y:.${opts.yDigits}f}<extra></extra>`,
    showlegend: false,
  };

  const layout = baseLayout(mobile);
  layout.margin = { ...layout.margin, r: mobile ? 12 : 24, b: 52, l: mobile ? 48 : 64 };
  const axisTitle = (text, hint) => ({
    text: mobile ? text : `${text}  <span style="font-size:10px">${hint}</span>`,
    font: { size: 12, color: COLORS.muted },
  });
  layout.xaxis = { ...layout.xaxis, title: axisTitle(opts.xLabel, '→ 스프레드 확대 · 신용 경계') };
  layout.yaxis = { ...layout.yaxis, title: axisTitle(opts.yLabel, '↑ 커브 가팔라짐') };
  if (opts.xRange) layout.xaxis.range = opts.xRange;
  if (opts.yRange) layout.yaxis.range = opts.yRange;
  layout.hovermode = 'closest';

  // 장단기 역전 기준선 (비율이면 Y=1, 금리차면 Y=0). 표시 범위 근처에 있을 때만 그린다.
  const inv = Number.isFinite(opts.yInversion) ? opts.yInversion : 1;
  const extentY = ys.concat(overlays.extentY || []);
  const yMin = Math.min(...extentY), yMax = Math.max(...extentY);
  const pad = (yMax - yMin) * 0.1;
  const showRef = inv >= yMin - pad && inv <= yMax + pad;
  const refLine = showRef
    ? [{
      type: 'line', xref: 'paper', x0: 0, x1: 1, yref: 'y', y0: inv, y1: inv,
      line: { color: REF_LINE_COLOR, width: 1.2, dash: 'dash' },
    }]
    : [];
  const refAnnotation = showRef
    ? [{
      xref: 'paper', x: 0.5, xanchor: 'center', yref: 'y', y: inv, yanchor: 'bottom',
      text: '10Y = 2Y 장단기 역전선', showarrow: false,
      font: { size: 10, color: '#7b8794' }, bgcolor: 'rgba(255,255,255,0.7)',
    }]
    : [];

  layout.shapes = [...refLine, ...(overlays.shapes || [])];
  layout.annotations = [...refAnnotation, ...(overlays.annotations || [])];

  // 이름이 있는 오버레이 trace(이벤트·전망 등)가 있으면 그래프 아래에 범례를 켠다.
  const hasNamedOverlay = (overlays.traces || []).some((t) => t.name && t.showlegend !== false);
  if (hasNamedOverlay) {
    layout.showlegend = true;
    layout.legend = {
      orientation: 'h', x: 0, y: -0.14, yanchor: 'top', xanchor: 'left',
      font: { size: 11, color: COLORS.muted }, bgcolor: 'rgba(255,255,255,0)',
    };
    layout.margin = { ...layout.margin, b: mobile ? 110 : 84 };
  }

  // trace 순서: 0 선, 1 연도표식, 2 궤적점, 3.. 오버레이, 마지막 = 현재점 (항상 맨 위)
  return Plotly.react(el, [path, yearDots, dots, ...(overlays.traces || []), current], layout, config());
}

/** 궤적 점 크기만 바꾼다 (전체 재렌더링 없이). trace 순서: 0 선, 1 연도표식, 2 궤적점 */
export function setTrajectoryMarkerSize(el, size) {
  if (el && el.data) Plotly.restyle(el, { 'marker.size': size }, [2]);
}

export function clearChart(el) {
  if (el && el.data) Plotly.purge(el);
}

export { COLORS };

// ============================================================ 사이클 맵
// 궤적 그래프와 같은 X·Y 위에 "연도 그라데이션 색 + VIX 크기" 원을 흩뿌려
// 사이클의 위치(X·Y)와 속도·긴장도(VIX)를 한 화면에서 본다.

// 연도 그라데이션 — 지각적으로 균일하고 색각이상에도 구분되는 viridis 계열 (과거 보라 → 최근 노랑)
const YEAR_SCALE = [
  [0, '#440154'], [0.15, '#482878'], [0.3, '#3e4a89'], [0.45, '#31688e'],
  [0.6, '#26828e'], [0.72, '#1f9e89'], [0.84, '#35b779'], [0.93, '#6ece58'], [1, '#d8e219'],
];

const PHASE_BG = {
  danger: 'rgba(176, 52, 47, 0.07)', recovery: 'rgba(219, 158, 33, 0.08)',
  expansion: 'rgba(35, 132, 90, 0.07)', slowdown: 'rgba(58, 91, 168, 0.07)',
};

/** 'YYYY-MM-DD' | 'YYYY' → 소수 연도 (색상 계산용) */
function fracYear(date) {
  if (date.length === 4) return Number(date) + 0.5;
  const [y, m, d] = date.split('-').map(Number);
  return y + ((m - 1) * 30.4 + (d - 1)) / 365.25;
}

/** VIX → 원 지름(px). 빈도가 촘촘할수록 작게. VIX 9 부근이 최소, 상한 있음. */
export function vixToSize(vix, freq) {
  const f = { daily: 0.45, weekly: 0.7, monthly: 0.95, annual: 1.5 }[freq] ?? 0.9;
  const base = { daily: 3, weekly: 4, monthly: 5, annual: 8 }[freq] ?? 5;
  return Math.min(base + f * Math.max(0, vix - 9), 48);
}

/**
 * @param {HTMLElement} el
 * @param {{date:string,x:number,y:number,raw:object}[]} points
 * @param {{freq:string, xLabel:string, yLabel:string, xShort:string, yShort:string, xDigits:number, yDigits:number,
 *          logX:boolean, logY:boolean, sizeMode:'vix'|'fixed', showLine:boolean, showLabels:boolean,
 *          showCycle:boolean, xSplit:number, yInversion:number, markerSize:number}} opts
 */
export function renderCycleMap(el, points, opts) {
  const mobile = isMobile();
  const n = points.length;
  const labels = points.map((p) => formatDateLabel(p.date, opts.freq));
  const years = points.map((p) => fracYear(p.date));
  const y0 = years[0], y1 = Math.max(years[n - 1], years[0] + 0.01);
  const vix = points.map((p) => (Number.isFinite(p.raw?.VIX) ? p.raw.VIX : null));
  const useVix = opts.sizeMode === 'vix';
  const gl = n > GL_THRESHOLD;
  const traces = [];

  if (opts.showLine) {
    traces.push({
      type: gl ? 'scattergl' : 'scatter', mode: 'lines', x: points.map((p) => p.x), y: points.map((p) => p.y),
      line: { color: 'rgba(60,72,88,0.22)', width: 1 }, hoverinfo: 'skip', showlegend: false,
    });
  }

  // 연도별 색 눈금 (8~12개)
  const span = Math.max(1, y1 - y0);
  const step = [1, 2, 3, 5, 10].find((s) => span / s <= 12) || 10;
  const tickYears = [];
  for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) tickYears.push(y);
  if (!tickYears.length) tickYears.push(Math.round(y0));

  const idxVix = [], idxNo = [];
  points.forEach((_, i) => ((useVix && vix[i] === null) ? idxNo : idxVix).push(i));
  const pick = (arr, idx) => idx.map((i) => arr[i]);
  const hover = `%{customdata[0]}<br>${opts.xShort}: %{x:.${opts.xDigits}f}<br>${opts.yShort}: %{y:.${opts.yDigits}f}` +
    '<br>VIX: %{customdata[1]}<extra></extra>';
  const custom = points.map((p, i) => [labels[i], vix[i] === null ? '—' : vix[i].toFixed(1)]);

  traces.push({
    type: gl ? 'scattergl' : 'scatter', mode: 'markers',
    x: pick(points, idxVix).map((p) => p.x), y: pick(points, idxVix).map((p) => p.y),
    customdata: pick(custom, idxVix),
    marker: {
      size: idxVix.map((i) => (useVix ? vixToSize(vix[i], opts.freq) : opts.markerSize)),
      sizemode: 'diameter',
      color: pick(years, idxVix), colorscale: YEAR_SCALE, cmin: y0, cmax: y1,
      opacity: 0.72,
      line: { width: gl ? 0 : 0.6, color: 'rgba(255,255,255,0.85)' },
      colorbar: mobile ? undefined : {
        thickness: 10, len: 0.7, outlinewidth: 0, title: { text: '연도', font: { size: 11, color: COLORS.muted } },
        tickvals: tickYears, ticktext: tickYears.map(String), tickfont: { size: 10, color: COLORS.muted },
      },
      showscale: !mobile,
    },
    hovertemplate: hover, showlegend: false,
  });

  if (idxNo.length) {
    traces.push({
      type: idxNo.length > GL_THRESHOLD ? 'scattergl' : 'scatter', mode: 'markers',
      x: pick(points, idxNo).map((p) => p.x), y: pick(points, idxNo).map((p) => p.y),
      customdata: pick(custom, idxNo),
      marker: { size: 5, color: 'rgba(0,0,0,0)', line: { width: 1, color: 'rgba(107,119,133,0.55)' } },
      name: 'VIX 값 없음', hovertemplate: hover, showlegend: true,
    });
  }

  // 날짜 라벨: 연도 표식 지점 + 현재
  if (opts.showLabels && n > 2) {
    // 현재 연도 라벨은 "현재" 표시와 겹치므로 뺀다
    const marks = pickYearMarks(points).filter((m) => m.year !== points[n - 1].date.slice(0, 4));
    traces.push({
      type: 'scatter', mode: 'text',
      x: marks.map((m) => points[m.index].x), y: marks.map((m) => points[m.index].y),
      text: marks.map((m) => {
        const d = points[m.index].date;
        return d.length === 4 ? d : `${d.slice(0, 4)}.${Number(d.slice(5, 7))}`;
      }),
      textposition: 'top center', textfont: { size: 10, color: '#1f2a37' },
      hoverinfo: 'skip', showlegend: false,
    });
  }

  // VIX 크기 범례 (가짜 점 — 화면 밖 좌표 대신 legendonly가 아닌 visible 점을 null로)
  if (useVix) {
    for (const v of [15, 30, 50]) {
      traces.push({
        type: 'scatter', mode: 'markers', x: [null], y: [null],
        marker: { size: vixToSize(v, opts.freq), color: 'rgba(107,119,133,0.25)', line: { width: 1, color: 'rgba(107,119,133,0.8)' } },
        name: `VIX ${v}`, showlegend: true, hoverinfo: 'skip',
      });
    }
  }

  // 현재 위치
  const cur = points[n - 1];
  traces.push({
    type: 'scatter', mode: mobile ? 'markers' : 'markers+text',
    x: [cur.x], y: [cur.y], customdata: [custom[n - 1]],
    text: [`<b>현재 (${labels[n - 1]})</b>`], textposition: 'top right', textfont: { size: 12, color: CURRENT_COLOR },
    marker: {
      size: Math.max(16, useVix && vix[n - 1] !== null ? vixToSize(vix[n - 1], opts.freq) + 6 : 16),
      color: 'rgba(192,57,43,0.18)', line: { width: 2.5, color: CURRENT_COLOR },
    },
    hovertemplate: `현재 · ${hover}`, showlegend: false,
  });

  // --- 배경: 4분면 (X 기준선 + 역전선)
  const shapes = [];
  const annotations = [];
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const xMin = Math.min(...xs), xMax = Math.max(...xs), yMin = Math.min(...ys), yMax = Math.max(...ys);
  const xs0 = Number.isFinite(opts.xSplit) ? opts.xSplit : (xMin + xMax) / 2;
  const inv = Number.isFinite(opts.yInversion) ? opts.yInversion : 1;
  // 로그 축에서 layout.range는 log10 값, shape 좌표는 원래 값(Plotly 2.x)이다 → 범위는 L로 계산하고 shape엔 D로 되돌린다.
  const L = (v, log) => (log ? Math.log10(Math.max(v, 1e-9)) : v);
  const D = (v, log) => (log ? 10 ** v : v);
  // 축 범위를 데이터에서 직접 정한다 (배경 사각형이 autorange를 넓히지 않도록). 값 공간(로그면 log10)에서 6% 여백.
  const padRange = (lo, hi) => { const d = (hi - lo) * 0.06 || 0.05; return [lo - d, hi + d]; };
  const xr = padRange(L(xMin, opts.logX), L(xMax, opts.logX));
  const yr = padRange(L(yMin, opts.logY), L(yMax, opts.logY));
  const xaL = Math.min(Math.max(L(xs0, opts.logX), xr[0]), xr[1]);
  const yaL = L(inv, opts.logY);
  const X = (v) => D(v, opts.logX), Y = (v) => D(v, opts.logY); // log10 공간 → shape 좌표
  const rect = (x0, x1, y0r, y1r, c) => ({
    type: 'rect', xref: 'x', yref: 'y', x0, x1, y0: y0r, y1: y1r, fillcolor: c, line: { width: 0 }, layer: 'below',
  });
  const yValidInv = !(opts.logY && inv <= 0);
  if (opts.showCycle) {
    if (yValidInv) {
      const yc = Math.min(Math.max(yaL, yr[0]), yr[1]);
      shapes.push(
        rect(X(xr[0]), X(xaL), Y(yc), Y(yr[1]), PHASE_BG.expansion), rect(X(xaL), X(xr[1]), Y(yc), Y(yr[1]), PHASE_BG.recovery),
        rect(X(xr[0]), X(xaL), Y(yr[0]), Y(yc), PHASE_BG.slowdown), rect(X(xaL), X(xr[1]), Y(yr[0]), Y(yc), PHASE_BG.danger),
      );
    }
    shapes.push({ type: 'line', xref: 'x', yref: 'paper', x0: X(xaL), x1: X(xaL), y0: 0, y1: 1, line: { color: 'rgba(90,100,115,0.35)', width: 1, dash: 'dot' }, layer: 'below' });
    const corner = (x, y, text, color, xanchor, yanchor) => ({
      xref: 'paper', yref: 'paper', x, y, xanchor, yanchor, showarrow: false,
      text: `<b>${text}</b>`, font: { size: mobile ? 10 : 13, color }, bgcolor: 'rgba(255,255,255,0.7)', borderpad: 3,
    });
    annotations.push(
      corner(0.01, 0.99, '#3 확장 / 호황 구간', '#1f6b47', 'left', 'top'),
      corner(0.99, 0.99, '#2 회복 구간', '#7d5a12', 'right', 'top'),
      corner(0.99, 0.01, '#1 위험 구간', '#8c2b2b', 'right', 'bottom'),
      corner(0.01, 0.01, '#4 둔화 구간', '#33487f', 'left', 'bottom'),
    );
    // 순환 방향 화살표 (개념도): #1 위험 → #2 회복 → #3 확장 → #4 둔화 → #1
    if (!mobile) {
      const arcs = [
        { p: 'M 0.95 0.22 Q 1.0 0.5 0.95 0.78', end: [0.95, 0.78], ax: 4, ay: 16 },   // 오른쪽: 위로
        { p: 'M 0.78 0.95 Q 0.5 1.0 0.22 0.95', end: [0.22, 0.95], ax: 16, ay: -3 }, // 위: 왼쪽으로
        { p: 'M 0.05 0.78 Q 0.0 0.5 0.05 0.22', end: [0.05, 0.22], ax: -4, ay: -16 }, // 왼쪽: 아래로
        { p: 'M 0.22 0.05 Q 0.5 0.0 0.78 0.05', end: [0.78, 0.05], ax: -16, ay: 3 }, // 아래: 오른쪽으로
      ];
      for (const a of arcs) {
        shapes.push({ type: 'path', xref: 'paper', yref: 'paper', path: a.p, line: { color: 'rgba(120,130,140,0.35)', width: 5 }, layer: 'below' });
        annotations.push({
          xref: 'paper', yref: 'paper', x: a.end[0], y: a.end[1], ax: a.ax, ay: a.ay, showarrow: true,
          arrowhead: 2, arrowsize: 1.1, arrowwidth: 5, arrowcolor: 'rgba(120,130,140,0.45)', text: '',
        });
      }
    }
  }
  // 역전선
  if (yValidInv && yaL >= yr[0] && yaL <= yr[1]) {
    shapes.push({ type: 'line', xref: 'paper', x0: 0, x1: 1, yref: 'y', y0: inv, y1: inv, line: { color: REF_LINE_COLOR, width: 1.2, dash: 'dash' } });
  }

  const layout = baseLayout(mobile);
  layout.margin = { l: mobile ? 48 : 70, r: mobile ? 12 : 20, t: 12, b: mobile ? 96 : 76 };
  const axisTitle = (t, log) => ({ text: `${t}${log ? ' <span style="font-size:10px">(로그)</span>' : ''}`, font: { size: 12, color: COLORS.muted } });
  layout.xaxis = { ...layout.xaxis, type: opts.logX ? 'log' : 'linear', range: xr, title: axisTitle(opts.xLabel, opts.logX) };
  layout.yaxis = { ...layout.yaxis, type: opts.logY ? 'log' : 'linear', range: yr, title: axisTitle(opts.yLabel, opts.logY) };
  // 로그 축 눈금: 기본 소수 눈금("4"=0.4 식)이 헷갈려서 읽기 쉬운 값을 직접 지정
  const NICE = [0.1, 0.2, 0.3, 0.5, 0.7, 1, 1.5, 2, 3, 5, 7, 10, 15, 20, 30, 50, 70, 100];
  const logTicks = (range) => {
    const lo = 10 ** range[0], hi = 10 ** range[1];
    const v = NICE.filter((t) => t >= lo && t <= hi);
    return v.length >= 2 ? { tickvals: v, ticktext: v.map(String) } : {};
  };
  if (opts.logX) Object.assign(layout.xaxis, logTicks(xr));
  if (opts.logY) Object.assign(layout.yaxis, logTicks(yr));
  layout.hovermode = 'closest';
  layout.shapes = shapes;
  layout.annotations = annotations;
  layout.showlegend = true;
  layout.legend = { orientation: 'h', x: 0, y: mobile ? -0.2 : -0.12, yanchor: 'top', font: { size: 11, color: COLORS.muted }, itemsizing: 'trace' };
  return Plotly.react(el, traces, layout, config());
}
