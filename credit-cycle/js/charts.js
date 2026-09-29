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
