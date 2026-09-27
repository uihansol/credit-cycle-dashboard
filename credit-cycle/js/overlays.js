// ============================================================
// overlays.js — 궤적 그래프 위에 덧그리는 선택적 요소들
// buildOverlays()가 돌려주는 {traces, shapes, annotations} 는
// charts.renderTrajectory() 에 그대로 전달되어 궤적 위에 그려진다.
// 전부 ctx.features 플래그로 켜고 끈다 (app.js의 체크박스와 연결).
// ============================================================

const PHASE_COLORS = {
  danger: 'rgba(176, 42, 42, 0.07)',
  recovery: 'rgba(219, 158, 33, 0.09)',
  expansion: 'rgba(45, 125, 70, 0.08)',
  slowdown: 'rgba(60, 90, 158, 0.08)',
};
const PHASE_TEXT_COLOR = {
  danger: '#8c2b2b', recovery: '#8a641c', expansion: '#276b45', slowdown: '#33487f',
};

/**
 * 주요 시기 정의. 궤적 위에서 이 구간에 속하는 점들을 굵은 색선으로 강조한다.
 * 필요하면 항목을 더 추가해도 자동으로 반영된다.
 */
export const EVENTS = [
  { id: 'dotcom', label: '2000 IT 버블', start: '2000-03-01', end: '2002-10-31', color: '#7a5cc0' },
  { id: 'gfc', label: '2008 금융위기', start: '2007-08-01', end: '2009-06-30', color: '#b0402a' },
  { id: 'covid', label: '2020 코로나', start: '2020-02-01', end: '2020-12-31', color: '#1f8fa6' },
  { id: 'hike22', label: '2022 금리인상기', start: '2022-03-01', end: '2023-07-31', color: '#c07a1f' },
];

/**
 * X 중앙값과 Y=1(장단기 역전선)로 화면을 4분면으로 나눠 배경색을 칠한다.
 * 이 4분면 구성은 "신용스프레드가 넓고 커브가 역전" = 위험,
 * "스프레드는 아직 넓지만 커브가 정상화" = 회복, "스프레드 좁고 커브 정상" = 확장,
 * "스프레드는 좁지만 커브가 역전 시작" = 둔화 라는 통상적인 신용 사이클 해석을
 * 따른 것으로, 하나의 참고 틀일 뿐 엄밀한 경기 판정은 아니다.
 * @param {{x:number,y:number}[]} points
 */
function phaseShapesAndLabels(points) {
  if (points.length < 4) return { shapes: [], annotations: [] };
  const xs = points.map((p) => p.x).slice().sort((a, b) => a - b);
  const xMed = xs[Math.floor(xs.length / 2)];
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const ys = points.map((p) => p.y);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const yMid = 1; // 장단기 역전 기준선
  // 패딩: 실제 점보다 살짝 넓게 칠해서 경계 위 점이 잘려 보이지 않게 한다.
  const padX = (xMax - xMin) * 0.04 || 0.1;
  const padY = (yMax - yMin) * 0.04 || 0.1;
  const x0 = xMin - padX, x1 = xMax + padX, y0 = yMin - padY, y1 = yMax + padY;
  const lowerY0 = y0, lowerY1 = Math.min(yMid, y1);
  const upperY0 = Math.max(yMid, y0), upperY1 = y1;
  const hasLower = yMid > y0; // 역전 구간(Y<1)이 실제로 보이는가
  const hasUpper = yMid < y1; // 정상 커브 구간(Y>1)이 실제로 보이는가

  const rect = (X0, X1, Y0, Y1, color) => ({
    type: 'rect', xref: 'x', yref: 'y', x0: X0, x1: X1, y0: Y0, y1: Y1,
    fillcolor: color, line: { width: 0 }, layer: 'below',
  });
  const label = (X, Y, text, color) => ({
    x: X, y: Y, xref: 'x', yref: 'y', text, showarrow: false,
    font: { size: 10, color }, xanchor: 'center', yanchor: 'middle', opacity: 0.85,
  });
  const midX = (a, b) => (a + b) / 2;

  const shapes = [];
  const annotations = [];

  if (hasLower) {
    shapes.push(rect(x0, xMed, lowerY0, lowerY1, PHASE_COLORS.slowdown));
    shapes.push(rect(xMed, x1, lowerY0, lowerY1, PHASE_COLORS.danger));
    annotations.push(label(midX(x0, xMed), midX(lowerY0, lowerY1), '#4 둔화', PHASE_TEXT_COLOR.slowdown));
    annotations.push(label(midX(xMed, x1), midX(lowerY0, lowerY1), '#1 위험', PHASE_TEXT_COLOR.danger));
  }
  if (hasUpper) {
    shapes.push(rect(x0, xMed, upperY0, upperY1, PHASE_COLORS.expansion));
    shapes.push(rect(xMed, x1, upperY0, upperY1, PHASE_COLORS.recovery));
    annotations.push(label(midX(x0, xMed), midX(upperY0, upperY1), '#3 확장/호황', PHASE_TEXT_COLOR.expansion));
    annotations.push(label(midX(xMed, x1), midX(upperY0, upperY1), '#2 회복', PHASE_TEXT_COLOR.recovery));
  }

  return { shapes, annotations };
}

/**
 * 주요 시기 구간에 속하는 궤적 점들을 뽑아 굵은 색선 trace로 만든다.
 * 화면에 표시 중인 points 범위와 겹치지 않는 이벤트는 건너뛴다.
 */
function eventTraces(points, xDigits, yDigits) {
  const traces = [];
  for (const ev of EVENTS) {
    const seg = points.filter((p) => p.date >= ev.start && p.date <= ev.end);
    if (seg.length < 2) continue;
    traces.push({
      type: seg.length > 2000 ? 'scattergl' : 'scatter',
      mode: 'lines+markers',
      x: seg.map((p) => p.x), y: seg.map((p) => p.y),
      line: { color: ev.color, width: 2.5 },
      marker: { size: 3, color: ev.color },
      name: ev.label,
      hovertemplate: `<b>${ev.label}</b><br>X: %{x:.${xDigits}f}<br>Y: %{y:.${yDigits}f}<extra></extra>`,
      showlegend: true,
    });
  }
  return traces;
}

/**
 * @param {{date:string,x:number,y:number}[]} points  화면에 표시 중인 궤적
 * @param {{version:string, freq:string, xDigits:number, yDigits:number, features?:object}} ctx
 * @returns {{traces:object[], shapes:object[], annotations:object[]}}
 */
export function buildOverlays(points, ctx) {
  const f = ctx.features || {};
  let traces = [];
  let shapes = [];
  let annotations = [];

  if (f.phases) {
    const p = phaseShapesAndLabels(points);
    shapes = shapes.concat(p.shapes);
    annotations = annotations.concat(p.annotations);
  }
  if (f.events) {
    traces = traces.concat(eventTraces(points, ctx.xDigits ?? 2, ctx.yDigits ?? 3));
  }

  // [확장 지점] 향후 추가할 수 있는 것들:
  //  - 현재 위치 큰 점은 charts.js renderTrajectory()에 이미 기본으로 그려진다.
  //  - 특정 날짜 선택 표시:   if (f.selectedDate) traces.push(selectedTrace(points, f.selectedDate));
  //  - 유사 시기 탐색 결과:   if (f.similar) traces.push(...similarTraces(f.similar));

  return { traces, shapes, annotations };
}
