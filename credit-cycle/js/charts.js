// ============================================================
// charts.js — Plotly 렌더링 (데이터 계산은 하지 않는다)
// ============================================================
import { formatDateLabel, toAxisDate } from './transform.js';

const GL_THRESHOLD = 4000; // 점이 많으면 WebGL(scattergl) 사용

const COLORS = {
  ink: '#1f2a37',
  muted: '#6b7785',
  grid: '#e7ebf0',
  xSeries: '#2c5f8a',
  ySeries: '#8a5a2c',
  path: 'rgba(60, 72, 88, 0.35)',
};

// 과거(연함) → 최근(진함)
const TIME_SCALE = [
  [0, '#d6e4f0'],
  [0.5, '#6f9ec4'],
  [1, '#12375c'],
];

const CURRENT_COLOR = '#c0392b';
const REF_LINE_COLOR = '#9aa5b1';

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
 * @param {{accessor:(p)=>number, label:string, digits:number, color?:string, freq:string}} opts
 */
export function renderTimeSeries(el, points, opts) {
  const mobile = isMobile();
  const trace = {
    type: points.length > GL_THRESHOLD ? 'scattergl' : 'scatter',
    mode: 'lines',
    x: points.map((p) => toAxisDate(p.date)),
    y: points.map(opts.accessor),
    customdata: points.map((p) => formatDateLabel(p.date, opts.freq)),
    line: { color: opts.color || COLORS.xSeries, width: 1.6 },
    hovertemplate: `%{customdata}<br>${opts.label}: %{y:.${opts.digits}f}<extra></extra>`,
  };
  const layout = baseLayout(mobile);
  layout.xaxis = { ...layout.xaxis, type: 'date' };
  layout.yaxis = { ...layout.yaxis, title: { text: mobile ? '' : opts.label, font: { size: 11, color: COLORS.muted } } };
  layout.hovermode = 'x';
  return Plotly.react(el, [trace], layout, config());
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
  };

  const yearMarks = pickYearMarks(points);
  // 연도 라벨 지점: 점을 살짝 키우고 진한 테두리를 둘러 궤적 점들과 구분한다.
  const yearDots = {
    type: 'scatter', mode: 'markers', x: yearMarks.map((m) => xs[m.index]), y: yearMarks.map((m) => ys[m.index]),
    marker: { size: Math.max(opts.markerSize + 3, 9), color: 'rgba(0,0,0,0)', line: { width: 1.6, color: COLORS.ink } },
    hoverinfo: 'skip',
    showlegend: false,
  };

  const dots = {
    type, mode: 'markers', x: xs, y: ys,
    customdata: labels,
    marker: {
      size: opts.markerSize,
      color: idx,
      colorscale: TIME_SCALE,
      cmin: 0,
      cmax: Math.max(n - 1, 1),
      line: { width: 0.5, color: 'rgba(255,255,255,0.8)' },
      opacity: 0.9,
      colorbar: mobile || n < 2 ? undefined : {
        thickness: 10, len: 0.75, outlinewidth: 0,
        tickvals: yearMarks.map((m) => m.index),
        ticktext: yearMarks.map((m) => `${m.year}년`),
        tickfont: { size: 10, color: COLORS.muted },
      },
      showscale: !mobile && n >= 2,
    },
    hovertemplate:
      `%{customdata}<br>X (${opts.xShort}): %{x:.${opts.xDigits}f}` +
      `<br>Y (${opts.yShort}): %{y:.${opts.yDigits}f}<extra></extra>`,
  };

  // 가장 최근 시점: 큰 점으로 강조해 "지금 위치"를 바로 찾을 수 있게 한다.
  const current = {
    type: 'scatter', mode: 'markers', x: [xs[n - 1]], y: [ys[n - 1]],
    customdata: [labels[n - 1]],
    marker: { size: Math.max(opts.markerSize + 7, 14), color: CURRENT_COLOR, line: { width: 2, color: '#ffffff' }, symbol: 'circle' },
    hovertemplate: `현재 (%{customdata})<br>X: %{x:.${opts.xDigits}f}<br>Y: %{y:.${opts.yDigits}f}<extra></extra>`,
  };

  const layout = baseLayout(mobile);
  layout.margin = { ...layout.margin, r: mobile ? 16 : 24, b: 52, l: mobile ? 48 : 64 };
  layout.xaxis = { ...layout.xaxis, title: { text: opts.xLabel, font: { size: 12, color: COLORS.muted } } };
  layout.yaxis = { ...layout.yaxis, title: { text: opts.yLabel, font: { size: 12, color: COLORS.muted } } };
  layout.hovermode = 'closest';

  // 장단기금리차 역전 기준선 (Y = 10Y/2Y = 1, 즉 10Y=2Y). Y축이 항상 이 값을 포함하지 않을 수 있어 존재할 때만 그린다.
  const yVals = ys;
  const yMin = Math.min(...yVals), yMax = Math.max(...yVals);
  const refLine = yMin < 1 && yMax > 0.9
    ? [{
      type: 'line', xref: 'paper', x0: 0, x1: 1, yref: 'y', y0: 1, y1: 1,
      line: { color: REF_LINE_COLOR, width: 1, dash: 'dash' },
    }]
    : [];
  const refAnnotation = refLine.length
    ? [{
      xref: 'paper', x: 1, xanchor: 'right', yref: 'y', y: 1, yanchor: 'bottom',
      text: '10Y = 2Y (장단기 역전선)', showarrow: false,
      font: { size: 10, color: REF_LINE_COLOR }, bgcolor: 'rgba(255,255,255,0.7)',
    }]
    : [];

  layout.shapes = [...refLine, ...(overlays.shapes || [])];
  layout.annotations = [...refAnnotation, ...(overlays.annotations || [])];

  return Plotly.react(el, [path, yearDots, dots, current, ...(overlays.traces || [])], layout, config());
}

/** 궤적 점 크기만 바꾼다 (전체 재렌더링 없이). trace 순서: 0 선, 1 연도표식, 2 궤적점, 3 현재점 */
export function setTrajectoryMarkerSize(el, size) {
  if (el && el.data) Plotly.restyle(el, { 'marker.size': size }, [2]);
}

export function clearChart(el) {
  if (el && el.data) Plotly.purge(el);
}

export { COLORS };
