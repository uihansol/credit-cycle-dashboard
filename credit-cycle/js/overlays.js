// ============================================================
// overlays.js — 궤적 그래프 위에 덧그리는 선택적 요소들
// buildOverlays()가 돌려주는 {traces, shapes, annotations} 는
// charts.renderTrajectory() 에 그대로 전달되어 궤적 위에 그려진다.
// 전부 ctx.features 플래그로 켜고 끈다 (app.js의 체크박스와 연결).
// ============================================================

import { PHASES, ellipsePath } from './forecast.js';
import { formatDateLabel, median } from './transform.js';

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
 * X 기준선(xSplit, 기본은 표시 중인 X의 중앙값)과 장단기 역전선(yMid)으로 화면을 4분면으로
 * 나눠 배경색을 칠한다. 이 4분면 구성은 "신용스프레드가 넓고 커브가 역전" = 위험,
 * "스프레드는 아직 넓지만 커브가 정상화" = 회복, "스프레드 좁고 커브 정상" = 확장,
 * "스프레드는 좁지만 커브가 역전 시작" = 둔화 라는 통상적인 신용 사이클 해석을
 * 따른 것으로, 하나의 참고 틀일 뿐 엄밀한 경기 판정은 아니다.
 * app.js는 xSplit으로 "분석 이력 전체의 X 중앙값"을 넘긴다 → 기간을 바꿔도 경계가 흔들리지 않는다.
 * @param {{x:number,y:number}[]} points  배경 범위를 정할 점들 (전망 경로 포함 가능)
 */
function phaseShapesAndLabels(points, xSplit, yMid = 1) {
  if (points.length < 4) return { shapes: [], annotations: [] };
  const xs = points.map((p) => p.x);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const xMed = Number.isFinite(xSplit) ? xSplit : median(xs);
  const ys = points.map((p) => p.y);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  // 패딩: 실제 점보다 살짝 넓게 칠해서 경계 위 점이 잘려 보이지 않게 한다.
  const padX = (xMax - xMin) * 0.06 || 0.1;
  const padY = (yMax - yMin) * 0.06 || 0.1;
  const x0 = Math.min(xMin - padX, xMed), x1 = Math.max(xMax + padX, xMed);
  const y0 = yMin - padY, y1 = yMax + padY;
  const lowerY0 = y0, lowerY1 = Math.min(yMid, y1);
  const upperY0 = Math.max(yMid, y0), upperY1 = y1;
  const hasLower = yMid > y0; // 역전 구간이 실제로 보이는가
  const hasUpper = yMid < y1; // 정상 커브 구간이 실제로 보이는가
  const hasLeft = xMed > xMin - padX;
  const hasRight = xMed < xMax + padX;

  const rect = (X0, X1, Y0, Y1, color) => ({
    type: 'rect', xref: 'x', yref: 'y', x0: X0, x1: X1, y0: Y0, y1: Y1,
    fillcolor: color, line: { width: 0 }, layer: 'below',
  });
  // 라벨은 각 사분면의 바깥 모서리에 붙여 궤적과 덜 겹치게 한다.
  const label = (X, Y, text, color, xanchor, yanchor) => ({
    x: X, y: Y, xref: 'x', yref: 'y', text: `<b>${text}</b>`, showarrow: false,
    font: { size: 11, color }, xanchor, yanchor, opacity: 0.9,
    bgcolor: 'rgba(255,255,255,0.6)', borderpad: 2,
  });

  const shapes = [];
  const annotations = [];
  const P = PHASES;
  if (hasLower && hasLeft) {
    shapes.push(rect(x0, xMed, lowerY0, lowerY1, P.slowdown.bg));
    annotations.push(label(x0, lowerY0, P.slowdown.full, P.slowdown.text, 'left', 'bottom'));
  }
  if (hasLower && hasRight) {
    shapes.push(rect(xMed, x1, lowerY0, lowerY1, P.danger.bg));
    annotations.push(label(x1, lowerY0, P.danger.full, P.danger.text, 'right', 'bottom'));
  }
  if (hasUpper && hasLeft) {
    shapes.push(rect(x0, xMed, upperY0, upperY1, P.expansion.bg));
    annotations.push(label(x0, upperY1, P.expansion.full, P.expansion.text, 'left', 'top'));
  }
  if (hasUpper && hasRight) {
    shapes.push(rect(xMed, x1, upperY0, upperY1, P.recovery.bg));
    annotations.push(label(x1, upperY1, P.recovery.full, P.recovery.text, 'right', 'top'));
  }
  // X 기준선 (세로 점선)
  if (hasLeft && hasRight) {
    shapes.push({
      type: 'line', xref: 'x', yref: 'y', x0: xMed, x1: xMed, y0, y1,
      line: { color: 'rgba(90,100,115,0.35)', width: 1, dash: 'dot' }, layer: 'below',
    });
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
      legendgroup: 'events',
    });
  }
  return traces;
}

/**
 * 궤적 위 "흐름 화살표": 궤적을 일정 간격으로 나눠 진행 방향을 화살표로 보여 준다.
 * 화살표는 시간 흐름(과거 → 최근) 방향을 가리킨다. 너무 짧은 이동은 건너뛴다.
 */
function flowArrows(points, count = 14) {
  if (points.length < 6) return [];
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const spanX = Math.max(...xs) - Math.min(...xs) || 1;
  const spanY = Math.max(...ys) - Math.min(...ys) || 1;
  const step = Math.max(2, Math.floor(points.length / count));
  const gap = Math.max(1, Math.floor(step / 3));
  const out = [];
  for (let i = step; i < points.length - 1; i += step) {
    const a = points[i - gap], b = points[i];
    const dist = Math.hypot((b.x - a.x) / spanX, (b.y - a.y) / spanY);
    if (dist < 0.012) continue;
    out.push({
      x: b.x, y: b.y, ax: a.x, ay: a.y, xref: 'x', yref: 'y', axref: 'x', ayref: 'y',
      showarrow: true, arrowhead: 2, arrowsize: 1.1, arrowwidth: 1.6,
      arrowcolor: 'rgba(31, 42, 55, 0.55)', text: '', standoff: 2,
    });
  }
  return out;
}

/**
 * 최근 구간 강조: 마지막 recentSteps 단계의 궤적을 굵은 선으로 다시 그려 "지금 어디로 가는지"를 보여 준다.
 */
function recentTrail(points, recentSteps, ctx) {
  if (points.length < 3 || !recentSteps) return [];
  const seg = points.slice(-Math.min(points.length, recentSteps + 1));
  return [{
    type: 'scatter', mode: 'lines',
    x: seg.map((p) => p.x), y: seg.map((p) => p.y),
    line: { color: 'rgba(192, 57, 43, 0.75)', width: 3, shape: 'spline', smoothing: 0.6 },
    name: ctx.recentLabel || '최근 흐름',
    hoverinfo: 'skip',
    showlegend: true,
  }];
}

/**
 * 일간·주간처럼 단계가 많은 예상 경로는 잔물결이 커서 방향이 잘 안 보인다 →
 * 표시용으로만 이동평균해 매끄럽게 그린다 (시작점=현재, 끝점=평균 끝점은 그대로 고정).
 */
function smoothPath(path) {
  const n = path.length;
  if (n <= 30) return path;
  const w = Math.max(1, Math.round(n / 12));
  return path.map((p, i) => {
    if (i === 0 || i === n - 1) return p;
    const r = Math.min(w, i, n - 1 - i);
    let sx = 0, sy = 0;
    for (let k = i - r; k <= i + r; k++) { sx += path[k].x; sy += path[k].y; }
    return { x: sx / (2 * r + 1), y: sy / (2 * r + 1) };
  });
}

/**
 * 전망 오버레이: 유사 시점 경로(가는 선), 도달 범위 타원, 예상 경로(굵은 점선 + 화살표).
 * @param {object} proj forecast.projectFromAnalogs 결과
 */
function projectionOverlay(proj, ctx) {
  const traces = [];
  const annotations = [];
  if (!proj) return { traces, annotations };
  const H = proj.horizon;
  const xd = ctx.xDigits ?? 2, yd = ctx.yDigits ?? 3;
  const color = '#6a3fb5';

  proj.paths.forEach((p, k) => {
    const hl = ctx.highlightAnalog === p.analog.date;
    traces.push({
      type: 'scatter', mode: 'lines',
      x: p.points.map((q) => q.x), y: p.points.map((q) => q.y),
      line: { color: hl ? 'rgba(106, 63, 181, 0.95)' : `rgba(106, 63, 181, ${0.12 + 0.5 * Math.min(1, p.weight * 4)})`, width: hl ? 2.6 : 1 },
      name: '유사 시점 이후 경로',
      legendgroup: 'analog',
      showlegend: k === 0,
      customdata: p.points.map(() => formatDateLabel(p.analog.date, ctx.freq)),
      hovertemplate: `%{customdata} 이후 경로를 현재에 적용<br>X: %{x:.${xd}f} · Y: %{y:.${yd}f}<extra></extra>`,
    });
  });

  if (proj.paths.length >= 3) {
    const e = ellipsePath(proj.ellipse);
    traces.push({
      type: 'scatter', mode: 'lines', x: e.x, y: e.y,
      fill: 'toself', fillcolor: 'rgba(106, 63, 181, 0.08)',
      line: { color: 'rgba(106, 63, 181, 0.45)', width: 1, dash: 'dot' },
      name: `${ctx.horizonLabel || ''} 뒤 도달 범위(약 68%)`,
      hoverinfo: 'skip',
    });
  }

  const labels = proj.mean.map((_, s) => (s === 0 ? '현재' : `+${s}`));
  const meanLine = smoothPath(proj.mean);
  traces.push({
    type: 'scatter', mode: 'lines',
    x: meanLine.map((q) => q.x), y: meanLine.map((q) => q.y),
    line: { color, width: 3.2, dash: 'dash', shape: 'spline', smoothing: 0.8 },
    name: `예상 경로(유사 시점 ${proj.paths.length}개 가중 평균)`,
    customdata: labels,
    hovertemplate: `예상 경로 %{customdata}<br>X: %{x:.${xd}f} · Y: %{y:.${yd}f}<extra></extra>`,
  });
  // 경로 끝 화살표 + 도착점 라벨
  const endPt = meanLine[H];
  const before = meanLine[Math.max(0, H - Math.max(1, Math.round(H / 5)))];
  annotations.push({
    x: endPt.x, y: endPt.y, ax: before.x, ay: before.y, xref: 'x', yref: 'y', axref: 'x', ayref: 'y',
    showarrow: true, arrowhead: 2, arrowsize: 1.4, arrowwidth: 2.6, arrowcolor: color, text: '',
  });
  annotations.push({
    x: endPt.x, y: endPt.y, xref: 'x', yref: 'y', text: `<b>${ctx.horizonLabel || ''} 뒤 예상</b>`,
    showarrow: false, xanchor: 'left', yanchor: 'bottom', xshift: 6, yshift: 4,
    font: { size: 11, color }, bgcolor: 'rgba(255,255,255,0.75)', borderpad: 2,
  });
  return { traces, annotations };
}

/**
 * 선택한 유사 시점의 "실제 과거 궤적" (그 시점 전후)을 강조한다.
 */
function analogHistoryTrace(history, analogDate, H, ctx) {
  if (!history || !analogDate) return [];
  const i = history.findIndex((p) => p.date === analogDate);
  if (i < 0) return [];
  const L = ctx.lookbackSteps || 1;
  const seg = history.slice(Math.max(0, i - L), Math.min(history.length, i + H + 1));
  return [{
    type: 'scatter', mode: 'lines+markers',
    x: seg.map((p) => p.x), y: seg.map((p) => p.y),
    line: { color: '#111827', width: 2.2 }, marker: { size: 4, color: '#111827' },
    name: `${formatDateLabel(analogDate, ctx.freq)} 전후 실제 궤적`,
    customdata: seg.map((p) => formatDateLabel(p.date, ctx.freq)),
    hovertemplate: `%{customdata}<br>X: %{x:.${ctx.xDigits ?? 2}f} · Y: %{y:.${ctx.yDigits ?? 3}f}<extra></extra>`,
  }];
}

/**
 * @param {{date:string,x:number,y:number}[]} points  화면에 표시 중인 궤적
 * @param {{version:string, freq:string, xDigits:number, yDigits:number, features?:object,
 *          xSplit?:number, yInversion?:number, projection?:object, recentSteps?:number,
 *          history?:object[], highlightAnalog?:string, horizonLabel?:string}} ctx
 * @returns {{traces:object[], shapes:object[], annotations:object[]}}
 */
export function buildOverlays(points, ctx) {
  const f = ctx.features || {};
  let traces = [];
  let shapes = [];
  let annotations = [];
  const proj = f.forecast ? ctx.projection : null;

  if (f.phases) {
    // 전망 경로가 화면 밖으로 나가도 배경이 이어지도록 전망 점도 범위 계산에 넣는다.
    const extent = proj ? points.concat(proj.mean, ...proj.paths.map((p) => p.points)) : points;
    const p = phaseShapesAndLabels(extent, ctx.xSplit, ctx.yInversion ?? 1);
    shapes = shapes.concat(p.shapes);
    annotations = annotations.concat(p.annotations);
  }
  if (f.arrows) annotations = annotations.concat(flowArrows(points));
  if (f.events) traces = traces.concat(eventTraces(points, ctx.xDigits ?? 2, ctx.yDigits ?? 3));
  if (f.recent) traces = traces.concat(recentTrail(points, ctx.recentSteps, ctx));
  if (proj) {
    if (ctx.highlightAnalog) traces = traces.concat(analogHistoryTrace(ctx.history, ctx.highlightAnalog, proj.horizon, ctx));
    const o = projectionOverlay(proj, ctx);
    traces = traces.concat(o.traces);
    annotations = annotations.concat(o.annotations);
  }
  const extentY = proj ? proj.paths.flatMap((p) => p.points.map((q) => q.y)) : [];
  return { traces, shapes, annotations, extentY };
}
