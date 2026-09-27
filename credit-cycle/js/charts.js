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
        thickness: 8, len: 0.6, outlinewidth: 0,
        tickvals: [0, n - 1],
        ticktext: [labels[0], labels[n - 1]],
        tickfont: { size: 10, color: COLORS.muted },
      },
      showscale: !mobile && n >= 2,
    },
    hovertemplate:
      `%{customdata}<br>X (${opts.xShort}): %{x:.${opts.xDigits}f}` +
      `<br>Y (${opts.yShort}): %{y:.${opts.yDigits}f}<extra></extra>`,
  };

  const layout = baseLayout(mobile);
  layout.margin = { ...layout.margin, r: mobile ? 16 : 24, b: 52, l: mobile ? 48 : 64 };
  layout.xaxis = { ...layout.xaxis, title: { text: opts.xLabel, font: { size: 12, color: COLORS.muted } } };
  layout.yaxis = { ...layout.yaxis, title: { text: opts.yLabel, font: { size: 12, color: COLORS.muted } } };
  layout.hovermode = 'closest';
  layout.shapes = overlays.shapes || [];
  layout.annotations = overlays.annotations || [];

  return Plotly.react(el, [path, dots, ...(overlays.traces || [])], layout, config());
}

/** 궤적 점 크기만 바꾼다 (전체 재렌더링 없이) */
export function setTrajectoryMarkerSize(el, size) {
  if (el && el.data) Plotly.restyle(el, { 'marker.size': size }, [1]);
}

export function clearChart(el) {
  if (el && el.data) Plotly.purge(el);
}

export { COLORS };
