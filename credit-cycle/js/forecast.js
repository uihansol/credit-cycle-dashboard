// ============================================================
// forecast.js — 유사 국면(analog) 기반 전망 + 현재 국면 진단 (순수 함수)
//
// 아이디어: "지금과 위치(X·Y)와 최근 흐름(모멘텀)이 비슷했던 과거 시점"을 찾고,
// 그 시점들 이후 실제로 궤적이 어떻게 움직였는지를 현재 위치에 옮겨 붙인다.
//   - 여러 과거 경로의 가중 평균 → 예상 경로
//   - 경로들의 흩어짐 → 가능 범위(분위수 밴드, 도달 범위 타원)
//   - 끝점이 어느 4분면(국면)에 떨어지는지 → 국면별 가능성
//   - 그 과거 시점 이후 NBER 침체가 있었는지 → 침체 동반 비율
// 통계 모형이 아니라 "역사가 비슷하게 흘러간다면"이라는 참고용 시나리오다.
// ============================================================
import { median, percentileRank, monthsBetween, addSteps } from './transform.js';

/**
 * 4단계 국면 (X 기준선 + Y 역전선 4분면). overlays.js 배경과 같은 정의.
 * 신용스프레드가 넓고 커브가 역전 = 위험, 스프레드 넓고 커브 정상 = 회복,
 * 스프레드 좁고 커브 정상 = 확장, 스프레드 좁고 커브 역전 = 둔화.
 */
export const PHASES = {
  danger: { id: 'danger', no: 1, label: '위험', full: '#1 위험', color: '#b0342f', bg: 'rgba(176, 52, 47, 0.08)', text: '#8c2b2b',
    desc: '신용스프레드가 넓고 장단기 금리가 역전된 상태 — 신용 긴장과 긴축이 겹친 구간' },
  recovery: { id: 'recovery', no: 2, label: '회복', full: '#2 회복', color: '#c98500', bg: 'rgba(219, 158, 33, 0.10)', text: '#7d5a12',
    desc: '스프레드는 아직 넓지만 커브가 정상화된 상태 — 완화 전환·스트레스 정점 통과 구간' },
  expansion: { id: 'expansion', no: 3, label: '확장', full: '#3 확장/호황', color: '#23845a', bg: 'rgba(35, 132, 90, 0.09)', text: '#1f6b47',
    desc: '스프레드가 좁고 커브가 정상인 상태 — 위험선호가 살아 있는 확장 구간' },
  slowdown: { id: 'slowdown', no: 4, label: '둔화', full: '#4 둔화', color: '#3a5ba8', bg: 'rgba(58, 91, 168, 0.09)', text: '#33487f',
    desc: '스프레드는 좁지만 커브가 역전된 상태 — 긴축 누적, 경기 후반 신호' },
};
export const PHASE_ORDER = ['danger', 'recovery', 'expansion', 'slowdown'];

/** (x, y) → 국면 id */
export function classifyPhase(x, y, xSplit, yInversion) {
  const wide = x >= xSplit;
  const inverted = y < yInversion;
  if (wide) return inverted ? 'danger' : 'recovery';
  return inverted ? 'slowdown' : 'expansion';
}

/** 빈도 설정의 stepsPerMonth로 개월 → 관측 단계 수 */
export function stepsFor(freqCfg, months) {
  return Math.max(1, Math.round(months * (freqCfg.stepsPerMonth ?? 1)));
}

// ------------------------------------------------------------ 척도 변환
// deltaMode 'mul' 은 로그 공간에서 계산한다 (변화를 비율로 옮기기 위해).
const fwd = (mode) => (mode === 'mul' ? (v) => (v > 0 ? Math.log(v) : NaN) : (v) => v);
const inv = (mode) => (mode === 'mul' ? (v) => Math.exp(v) : (v) => v);

/** 이상값에 덜 흔들리는 척도: IQR/1.349, 안 되면 표준편차, 그래도 0이면 1 */
export function robustScale(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length < 2) return 1;
  const q = (p) => {
    const i = (v.length - 1) * p;
    const lo = Math.floor(i), hi = Math.ceil(i);
    return v[lo] + (v[hi] - v[lo]) * (i - lo);
  };
  const iqr = (q(0.75) - q(0.25)) / 1.349;
  if (iqr > 1e-12) return iqr;
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / (v.length - 1));
  return sd > 1e-12 ? sd : 1;
}

/**
 * 짧은 이력(예: FRED 3년 제한이 걸린 하이일드)을 다른 버전의 장기 이력으로 보완한다.
 * 겹치는 날짜에서 own.x ≈ a + b·proxy.x 를 최소제곱으로 맞추고(deltaMode='mul'이면
 * 로그-로그), own 시작 이전 구간은 환산한 proxy 점으로 채운다. 환산된 점은 proxied=true.
 * 겹치는 점이 minOverlap 미만이면 보완하지 않는다.
 * @returns {{points:object[], fit:{a:number,b:number,r2:number,n:number,from:string,to:string}|null}}
 */
export function spliceProxyHistory(own, proxy, { mode = 'add', minOverlap = 12 } = {}) {
  if (!own.length || !proxy.length) return { points: own, fit: null };
  const f = fwd(mode), g = inv(mode);
  const proxyByDate = new Map(proxy.map((p) => [p.date, p]));
  const pairs = [];
  for (const p of own) {
    const q = proxyByDate.get(p.date);
    if (!q) continue;
    const a = f(q.x), b = f(p.x);
    if (Number.isFinite(a) && Number.isFinite(b)) pairs.push([a, b, p.date]);
  }
  if (pairs.length < minOverlap) return { points: own, fit: null };
  const n = pairs.length;
  const mx = pairs.reduce((s, p) => s + p[0], 0) / n;
  const my = pairs.reduce((s, p) => s + p[1], 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const [x, y] of pairs) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); syy += (y - my) ** 2; }
  if (sxx < 1e-12) return { points: own, fit: null };
  const b = sxy / sxx;
  const a = my - b * mx;
  const r2 = syy > 1e-12 ? (sxy * sxy) / (sxx * syy) : 0;
  const start = own[0].date;
  const head = [];
  for (const q of proxy) {
    if (q.date >= start) break;
    const x = g(a + b * f(q.x));
    if (Number.isFinite(x)) head.push({ ...q, x, proxied: true });
  }
  return {
    points: head.concat(own),
    fit: { a, b, r2, n, from: pairs[0][2], to: pairs[n - 1][2] },
  };
}

// ------------------------------------------------------------ 유사 시점 탐색
/**
 * 현재 시점(currentIndex)과 비슷한 과거 시점을 찾는다.
 * 특징 = [위치 X, 위치 Y, 최근 L단계 변화 ΔX, ΔY], 각각 견고한 척도로 나눈 뒤 유클리드 거리.
 * 이후 H단계 경로를 알고 있어야 하므로 i + H ≤ currentIndex 인 시점만 후보다 (미래 정보 누설 없음 →
 * 종료일을 과거로 옮기면 그때 기준의 전망을 그대로 되짚어 볼 수 있다).
 * 같은 에피소드가 여러 번 뽑히지 않도록 서로 sep 단계 이상 떨어진 시점만 고른다.
 * @param {{date:string,x:number,y:number}[]} history 날짜순 전체 이력
 * @returns {{index:number, date:string, distance:number}[]}
 */
export function findAnalogs(history, currentIndex, opts) {
  const { horizon: H, lookback: L, separation: sep, count: k = 10, momentumWeight: wm = 0.8,
    modeX = 'add', modeY = 'add' } = opts;
  if (currentIndex < 0 || currentIndex >= history.length) return [];
  const fx = fwd(modeX), fy = fwd(modeY);
  const tx = history.map((p) => fx(p.x));
  const ty = history.map((p) => fy(p.y));
  const upto = (arr) => arr.slice(0, currentIndex + 1);
  const sx = robustScale(upto(tx));
  const sy = robustScale(upto(ty));
  const useMomentum = currentIndex >= L && wm > 0;
  const mx = (i) => tx[i] - tx[i - L];
  const my = (i) => ty[i] - ty[i - L];
  let smx = 1, smy = 1;
  if (useMomentum) {
    const dxs = [], dys = [];
    for (let i = L; i <= currentIndex; i++) { dxs.push(mx(i)); dys.push(my(i)); }
    smx = robustScale(dxs);
    smy = robustScale(dys);
  }
  const c = currentIndex;
  const cand = [];
  for (let i = useMomentum ? L : 0; i + H <= c; i++) {
    if (!Number.isFinite(tx[i]) || !Number.isFinite(ty[i])) continue;
    let d2 = ((tx[i] - tx[c]) / sx) ** 2 + ((ty[i] - ty[c]) / sy) ** 2;
    if (useMomentum) {
      d2 += wm * wm * (((mx(i) - mx(c)) / smx) ** 2 + ((my(i) - my(c)) / smy) ** 2);
    }
    if (Number.isFinite(d2)) cand.push({ index: i, distance: Math.sqrt(d2) });
  }
  cand.sort((a, b) => a.distance - b.distance);
  const picked = [];
  for (const cnd of cand) {
    if (picked.every((p) => Math.abs(p.index - cnd.index) >= sep)) {
      picked.push({ ...cnd, date: history[cnd.index].date });
      if (picked.length >= k) break;
    }
  }
  return picked;
}

// ------------------------------------------------------------ 전망 경로
function weightedQuantile(values, weights, q) {
  const idx = values.map((v, i) => i).filter((i) => Number.isFinite(values[i]))
    .sort((a, b) => values[a] - values[b]);
  if (!idx.length) return NaN;
  const total = idx.reduce((s, i) => s + weights[i], 0);
  let acc = 0;
  for (const i of idx) {
    acc += weights[i];
    if (acc / total >= q) return values[i];
  }
  return values[idx[idx.length - 1]];
}

/**
 * 유사 시점들의 이후 H단계 경로를 현재 위치에 옮겨 붙여 시나리오 경로를 만든다.
 * @returns {null | {
 *   current:{date,x,y}, horizon:number,
 *   paths:{analog:object, weight:number, points:{x,y}[]}[],
 *   mean:{x,y}[], bands:{q10,q25,q50,q75,q90:{x:number[],y:number[]}},
 *   ellipse:{cx,cy,sxx,syy,sxy}, weights:number[]
 * }}
 */
export function projectFromAnalogs(history, currentIndex, analogs, { horizon: H, modeX = 'add', modeY = 'add' }) {
  if (!analogs.length) return null;
  const fx = fwd(modeX), fy = fwd(modeY), gx = inv(modeX), gy = inv(modeY);
  const cur = history[currentIndex];
  const cx = fx(cur.x), cy = fy(cur.y);
  // 가중치: 가까울수록 크게. 거리의 중앙값을 폭으로 쓰는 가우시안 커널.
  const h = median(analogs.map((a) => a.distance)) || 1;
  const raw = analogs.map((a) => Math.exp(-0.5 * (a.distance / h) ** 2));
  const sumW = raw.reduce((s, w) => s + w, 0) || 1;
  const weights = raw.map((w) => w / sumW);

  const paths = analogs.map((a, k) => {
    const bx = fx(history[a.index].x), by = fy(history[a.index].y);
    const pts = [];
    for (let s = 0; s <= H; s++) {
      const p = history[a.index + s];
      pts.push({ x: gx(cx + fx(p.x) - bx), y: gy(cy + fy(p.y) - by) });
    }
    return { analog: a, weight: weights[k], points: pts };
  });

  const mean = [];
  const bands = { q10: { x: [], y: [] }, q25: { x: [], y: [] }, q50: { x: [], y: [] }, q75: { x: [], y: [] }, q90: { x: [], y: [] } };
  for (let s = 0; s <= H; s++) {
    let mxs = 0, mys = 0;
    const xs = [], ys = [];
    paths.forEach((p, k) => {
      xs.push(p.points[s].x); ys.push(p.points[s].y);
      mxs += weights[k] * fx(p.points[s].x);
      mys += weights[k] * fy(p.points[s].y);
    });
    mean.push({ x: gx(mxs), y: gy(mys) });
    for (const [key, q] of [['q10', 0.1], ['q25', 0.25], ['q50', 0.5], ['q75', 0.75], ['q90', 0.9]]) {
      bands[key].x.push(weightedQuantile(xs, weights, q));
      bands[key].y.push(weightedQuantile(ys, weights, q));
    }
  }

  // 끝점 분포의 가중 공분산 → 도달 범위 타원
  const ends = paths.map((p) => p.points[H]);
  const ecx = ends.reduce((s, e, k) => s + weights[k] * e.x, 0);
  const ecy = ends.reduce((s, e, k) => s + weights[k] * e.y, 0);
  let sxx = 0, syy = 0, sxy = 0;
  ends.forEach((e, k) => {
    sxx += weights[k] * (e.x - ecx) ** 2;
    syy += weights[k] * (e.y - ecy) ** 2;
    sxy += weights[k] * (e.x - ecx) * (e.y - ecy);
  });

  return { current: cur, horizon: H, paths, mean, bands, weights, ellipse: { cx: ecx, cy: ecy, sxx, syy, sxy } };
}

/**
 * 공분산 타원 윤곽선 좌표 (2차원 정규 가정, k=1.515 ≈ 68% 포함).
 * @returns {{x:number[], y:number[]}}
 */
export function ellipsePath({ cx, cy, sxx, syy, sxy }, k = 1.515, n = 60) {
  const tr = sxx + syy, det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(tr * tr / 4 - det, 0));
  const l1 = Math.max(tr / 2 + disc, 0), l2 = Math.max(tr / 2 - disc, 0);
  const theta = Math.abs(sxy) < 1e-15 ? (sxx >= syy ? 0 : Math.PI / 2) : Math.atan2(l1 - sxx, sxy);
  const a = k * Math.sqrt(l1), b = k * Math.sqrt(l2);
  const x = [], y = [];
  for (let i = 0; i <= n; i++) {
    const t = (2 * Math.PI * i) / n;
    const ex = a * Math.cos(t), ey = b * Math.sin(t);
    x.push(cx + ex * Math.cos(theta) - ey * Math.sin(theta));
    y.push(cy + ex * Math.sin(theta) + ey * Math.cos(theta));
  }
  return { x, y };
}

/** 날짜 d 이후 months 개월 안에 침체 구간과 겹치는가 */
export function recessionWithin(date, months, periods) {
  const d = date.length === 4 ? `${date}-07-01` : date;
  const endD = addSteps(d.slice(0, 7) + '-01', 'monthly', Math.ceil(months));
  return periods.some((p) => p.start <= endD && p.end > d);
}

/**
 * 전망 요약: 국면 가능성, 방향 가능성, 예상 변화, 침체 동반 비율(+ 평소 비율).
 * @param {object} proj projectFromAnalogs 결과
 * @param {{xSplit:number, yInversion:number, periods?:{start,end}[], horizonMonths:number,
 *          history?:object[], currentIndex?:number, horizonSteps?:number}} ctx
 */
export function summarizeProjection(proj, ctx) {
  if (!proj) return null;
  const { xSplit, yInversion } = ctx;
  const H = proj.horizon;
  const probs = { danger: 0, recovery: 0, expansion: 0, slowdown: 0 };
  let pWiden = 0, pSteepen = 0;
  proj.paths.forEach((p) => {
    const e = p.points[H];
    probs[classifyPhase(e.x, e.y, xSplit, yInversion)] += p.weight;
    if (e.x > proj.current.x) pWiden += p.weight;
    if (e.y > proj.current.y) pSteepen += p.weight;
  });
  const end = proj.mean[H];
  const out = {
    probs,
    pWiden,
    pSteepen,
    expected: { x: end.x, y: end.y, dx: end.x - proj.current.x, dy: end.y - proj.current.y },
    fromPhase: classifyPhase(proj.current.x, proj.current.y, xSplit, yInversion),
    toPhase: classifyPhase(end.x, end.y, xSplit, yInversion),
    recession: null,
  };
  const periods = ctx.periods || [];
  if (periods.length) {
    let pRec = 0;
    proj.paths.forEach((p) => { if (recessionWithin(p.analog.date, ctx.horizonMonths, periods)) pRec += p.weight; });
    // 평소 비율: 같은 조건(미래를 아는 과거 시점 전체)에서 H개월 안에 침체가 겹친 비율
    let base = null;
    if (ctx.history && Number.isInteger(ctx.currentIndex) && ctx.horizonSteps) {
      const lastPeriodEnd = periods[periods.length - 1].end;
      let hit = 0, tot = 0;
      const stride = Math.max(1, Math.floor(ctx.history.length / 1500)); // 일간 자료는 표본을 성기게
      for (let i = 0; i + ctx.horizonSteps <= ctx.currentIndex; i += stride) {
        const d = ctx.history[i].date;
        if (d > lastPeriodEnd) break;
        tot += 1;
        if (recessionWithin(d, ctx.horizonMonths, periods)) hit += 1;
      }
      base = tot ? hit / tot : null;
    }
    out.recession = { probability: pRec, base };
  }
  return out;
}

// ------------------------------------------------------------ 현재 국면 진단
function trendOf(delta, scale, threshold = 0.25) {
  if (!Number.isFinite(delta)) return 'flat';
  if (delta > threshold * scale) return 'up';
  if (delta < -threshold * scale) return 'down';
  return 'flat';
}

const FLOW_TEXT = {
  'up|up': { title: '스프레드 확대 · 커브 가팔라짐', text: '신용 경계감이 커지는 가운데 단기금리가 먼저 내려가는(또는 장기금리가 오르는) 조합입니다. 과거에는 경기 둔화가 확인되며 금리 인하가 시작되는 침체 진입 전후에 자주 나타났습니다.' },
  'up|down': { title: '스프레드 확대 · 커브 평탄화', text: '긴축이 이어지는 가운데 신용 스트레스가 커지는 조합입니다. 경기 후반, 금융 여건이 빡빡해질 때 흔합니다.' },
  'up|flat': { title: '스프레드 확대', text: '장단기 금리 구조는 크게 변하지 않은 채 신용스프레드만 넓어지고 있습니다. 위험회피 심리가 커지고 있다는 신호입니다.' },
  'down|up': { title: '스프레드 축소 · 커브 가팔라짐', text: '위험선호가 회복되고 커브가 정상화되는 조합입니다. 과거에는 침체 이후 회복·확장 초기에 전형적으로 나타났습니다.' },
  'down|down': { title: '스프레드 축소 · 커브 평탄화', text: '신용 여건은 양호하지만 긴축으로 커브가 눌리는 조합입니다. 확장 중·후반에 흔합니다.' },
  'down|flat': { title: '스프레드 축소', text: '금리 구조는 비슷한 가운데 신용스프레드가 좁아지고 있습니다. 위험선호가 강해지는 흐름입니다.' },
  'flat|up': { title: '커브 가팔라짐', text: '신용스프레드는 안정적인 가운데 장단기 금리차가 벌어지고 있습니다.' },
  'flat|down': { title: '커브 평탄화', text: '신용스프레드는 안정적인 가운데 장단기 금리차가 좁아지고 있습니다.' },
  'flat|flat': { title: '뚜렷한 방향 없음', text: '최근 신용스프레드와 장단기 금리 구조 모두 큰 변화 없이 제자리에 머물고 있습니다.' },
};

/**
 * 현재 시점의 거시 환경 진단.
 * @param {{date,x,y,raw?}[]} history 분석용 전체 이력 (프록시 포함 가능)
 * @param {number} currentIndex
 * @param {{xSplit:number, yInversion:number, stepsPerMonth:number, modeX?:string, modeY?:string}} ctx
 */
export function diagnose(history, currentIndex, ctx) {
  const cur = history[currentIndex];
  if (!cur) return null;
  const spm = ctx.stepsPerMonth ?? 1;
  const back = (months) => {
    const i = currentIndex - Math.max(1, Math.round(months * spm));
    return i >= 0 ? history[i] : null;
  };
  const upto = history.slice(0, currentIndex + 1);
  const xs = upto.map((p) => p.x), ys = upto.map((p) => p.y);
  const flowMonths = Math.max(3, Math.ceil(1 / spm)); // 연간은 최소 1단계
  const prev = back(flowMonths);
  // 변화의 크기를 "평소 같은 기간 변화"의 척도와 비교해 방향을 판정
  const L = Math.max(1, Math.round(flowMonths * spm));
  const dxs = [], dys = [];
  for (let i = L; i <= currentIndex; i++) { dxs.push(history[i].x - history[i - L].x); dys.push(history[i].y - history[i - L].y); }
  const tx = prev ? trendOf(cur.x - prev.x, robustScale(dxs)) : 'flat';
  const ty = prev ? trendOf(cur.y - prev.y, robustScale(dys)) : 'flat';

  // 역전 이력: 최근 24개월 안에 역전이 있었는데 지금은 정상이면 "역전 해소 직후"
  const inverted = cur.y < ctx.yInversion;
  const win = Math.max(1, Math.round(24 * spm));
  let lastInverted = null;
  for (let i = currentIndex; i >= Math.max(0, currentIndex - win); i--) {
    if (history[i].y < ctx.yInversion) { lastInverted = history[i].date; break; }
  }
  const monthsSinceInversion = lastInverted && !inverted ? monthsBetween(lastInverted, cur.date) : null;

  const xPct = percentileRank(xs, cur.x);
  const signals = [];
  if (inverted) signals.push({ level: 'warn', text: '장단기 금리가 역전된 상태입니다. 역사적으로 역전은 경기침체에 6~24개월 선행하는 경우가 많았습니다.' });
  else if (monthsSinceInversion !== null) signals.push({ level: 'warn', text: `약 ${Math.max(1, Math.round(monthsSinceInversion))}개월 전 장단기 역전이 해소되었습니다. 과거에는 역전 해소(재스티프닝) 전후에 침체가 시작된 사례가 많았습니다.` });
  if (xPct >= 80) signals.push({ level: 'warn', text: `신용스프레드가 과거 이력의 상위 ${Math.round(100 - xPct)}% 수준으로 넓습니다 — 신용 스트레스 구간.` });
  else if (xPct <= 20) signals.push({ level: 'info', text: `신용스프레드가 과거 이력의 하위 ${Math.max(1, Math.round(xPct))}% 수준으로 좁습니다 — 위험선호가 강하지만, 충격 시 되돌림 폭이 클 수 있습니다.` });

  return {
    current: cur,
    phase: classifyPhase(cur.x, cur.y, ctx.xSplit, ctx.yInversion),
    xPct,
    yPct: percentileRank(ys, cur.y),
    change: {
      m3: back(3) ? { x: cur.x - back(3).x, y: cur.y - back(3).y } : null,
      m12: back(12) ? { x: cur.x - back(12).x, y: cur.y - back(12).y } : null,
    },
    flow: { x: tx, y: ty, months: flowMonths, ...FLOW_TEXT[`${tx}|${ty}`] },
    inverted,
    monthsSinceInversion,
    signals,
  };
}
