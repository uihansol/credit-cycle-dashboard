// ============================================================
// overlays.js — 궤적 그래프 위에 덧그릴 요소 (향후 확장 전용)
//
// buildOverlays()가 돌려주는 { traces, shapes, annotations } 는
// charts.renderTrajectory() 에 그대로 전달되어 궤적 위에 그려진다.
// 이번 버전에서는 아무것도 그리지 않는다.
// ============================================================

/**
 * 주요 시기 정의 (향후 사용). enabled=false 인 동안은 그리지 않는다.
 * 예) { id:'gfc', label:'2008 금융위기', start:'2007-08-01', end:'2009-06-30', color:'#b3413b' }
 */
export const EVENTS = [
  // { id: 'dotcom', label: '2000 IT 버블',   start: '2000-03-01', end: '2002-10-31' },
  // { id: 'gfc',    label: '2008 금융위기',  start: '2007-08-01', end: '2009-06-30' },
  // { id: 'covid',  label: '2020 코로나',    start: '2020-02-01', end: '2020-12-31' },
  // { id: 'hike22', label: '2022 금리인상기', start: '2022-03-01', end: '2023-07-31' },
];

/**
 * 4단계 국면 영역 (향후 사용). 기준값 확정 후 shapes 로 변환.
 * 예) { id:1, label:'#1 위험', x0, x1, y0, y1, fill:'rgba(179,65,59,0.06)' }
 */
export const PHASES = [];

/**
 * @param {{date:string,x:number,y:number}[]} points  화면에 표시 중인 궤적
 * @param {{version:string, freq:string, features?:object}} ctx
 * @returns {{traces:object[], shapes:object[], annotations:object[]}}
 */
export function buildOverlays(points, ctx) {
  const traces = [];
  const shapes = [];
  const annotations = [];
  const f = ctx.features || {};

  // [확장 1] 4단계 사이클 영역:   if (f.phases) shapes.push(...phaseShapes(PHASES));
  // [확장 2] 주요 시기 하이라이트: if (f.events) traces.push(...eventTraces(points, EVENTS));
  // [확장 3] 현재 위치 큰 점:      if (f.currentPoint) traces.push(currentPointTrace(points.at(-1)));
  // [확장 4] 선택 날짜 표시:       if (f.selectedDate) traces.push(selectedTrace(points, f.selectedDate));
  // [확장 5] 유사 시기 탐색 결과:  if (f.similar) traces.push(...similarTraces(f.similar));

  return { traces, shapes, annotations };
}
