// ============================================================
// transform.js — 순수 계산 함수 (DOM 없음 → 테스트·확장 용이)
// ============================================================

/**
 * 시계열들을 날짜 기준으로 합친다. required 키가 모두 있는 날짜만 행으로 남기고,
 * optional 키는 없으면 null로 채운다 (그 값을 쓰는 버전에서만 자연히 제외됨).
 * 이렇게 하면 하이일드처럼 시작일이 늦은 지표를 추가해도 기존 지표의 과거 구간이
 * 잘려나가지 않는다. required 를 생략하면 이전처럼 모든 키를 필수로 취급한다.
 * @param {Record<string, Map<string, number|null>>} maps
 * @param {string[]} [required] 값이 없으면 그 날짜를 제외할 키 (기본: 전체 키)
 * @returns {{date:string, [key:string]: number|null}[]}
 */
export function alignSeries(maps, required = null) {
  const keys = Object.keys(maps);
  const req = required || keys;
  const optional = keys.filter((k) => !req.includes(k));
  const base = maps[req[0]];
  const rows = [];
  for (const [date, v0] of base) {
    if (v0 === null || !Number.isFinite(v0)) continue;
    const row = { date, [req[0]]: v0 };
    let ok = true;
    for (let i = 1; i < req.length; i++) {
      const v = maps[req[i]].get(date);
      if (v === null || v === undefined || !Number.isFinite(v)) { ok = false; break; }
      row[req[i]] = v;
    }
    if (!ok) continue;
    for (const k of optional) {
      const v = maps[k].get(date);
      row[k] = v === null || v === undefined || !Number.isFinite(v) ? null : v;
    }
    rows.push(row);
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return rows;
}

/**
 * 월간 정렬 데이터 → 연평균. date는 'YYYY'. months = 관측치 자체 개월 수(분모 아님).
 * 키별로 실제 값이 있는 달만 평균에 넣는다 (하이일드처럼 뒤늦게 시작하는 지표가
 * 섞여 있어도 앞선 연도의 다른 지표 평균이 깨지지 않는다). 값이 하나도 없는 키는
 * 그 연도에서 null.
 */
export function aggregateAnnualMean(rows, keys = ['BAA', 'AAA', 'GS10', 'GS2', 'HY']) {
  const byYear = new Map();
  for (const r of rows) {
    const y = r.date.slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, { n: 0, sums: {}, counts: {} });
    const g = byYear.get(y);
    g.n += 1;
    for (const k of keys) {
      const v = r[k];
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      g.sums[k] = (g.sums[k] || 0) + v;
      g.counts[k] = (g.counts[k] || 0) + 1;
    }
  }
  return [...byYear.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([y, g]) => ({
      date: y,
      months: g.n,
      ...Object.fromEntries(keys.map((k) => [k, g.counts[k] ? g.sums[k] / g.counts[k] : null])),
    }));
}

/**
 * 일간 정렬 데이터 → 주평균. 한 주 = 월~일 (금요일 마감 주). date는 그 주의
 * "마지막 실제 관측일"(보통 금요일)이라 진행 중인 주도 미래 날짜가 생기지 않는다.
 * days = 그 주에 들어간 관측일 수. 키별로 값이 있는 날만 평균에 넣는다(연평균과 같은 규칙).
 */
export function aggregateWeeklyMean(rows, keys = ['BAA', 'AAA', 'GS10', 'GS2', 'HY']) {
  const byWeek = new Map();
  for (const r of rows) {
    const wk = weekEnding(r.date);
    if (!byWeek.has(wk)) byWeek.set(wk, { n: 0, last: r.date, sums: {}, counts: {} });
    const g = byWeek.get(wk);
    g.n += 1;
    if (r.date > g.last) g.last = r.date;
    for (const k of keys) {
      const v = r[k];
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      g.sums[k] = (g.sums[k] || 0) + v;
      g.counts[k] = (g.counts[k] || 0) + 1;
    }
  }
  return [...byWeek.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, g]) => ({
      date: g.last,
      days: g.n,
      ...Object.fromEntries(keys.map((k) => [k, g.counts[k] ? g.sums[k] / g.counts[k] : null])),
    }));
}

/** 'YYYY-MM-DD' 가 속한 주(월~일)의 금요일 날짜. 토·일은 그 주 금요일로 묶는다. */
export function weekEnding(date) {
  const d = parseUTC(date);
  const dow = d.getUTCDay(); // 0=일 … 6=토
  const offset = dow === 0 ? -2 : 5 - dow; // 일요일은 이틀 전 금요일, 나머지는 이번 주 금요일
  d.setUTCDate(d.getUTCDate() + offset);
  return iso(d);
}

const parseUTC = (date) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
};
const iso = (d) => d.toISOString().slice(0, 10);

/**
 * 날짜를 빈도 기준으로 k 단계 뒤로 민다 (전망 경로의 미래 날짜 생성용).
 * daily = 영업일(주말 건너뜀), weekly = 7일, monthly = 1개월, annual('YYYY') = 1년.
 */
export function addSteps(date, freq, k) {
  if (date.length === 4 || freq === 'annual') return String(Number(date.slice(0, 4)) + k);
  const d = parseUTC(date);
  if (freq === 'monthly') {
    d.setUTCMonth(d.getUTCMonth() + k);
    return iso(d);
  }
  if (freq === 'weekly') {
    d.setUTCDate(d.getUTCDate() + 7 * k);
    return iso(d);
  }
  let left = k;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) left -= 1;
  }
  return iso(d);
}

/** 두 날짜 사이의 개월 수 (대략, 소수 포함). 연간 'YYYY'는 연중앙으로 본다. */
export function monthsBetween(a, b) {
  const pa = parseUTC(a.length === 4 ? `${a}-07-01` : a);
  const pb = parseUTC(b.length === 4 ? `${b}-07-01` : b);
  return (pb - pa) / (1000 * 60 * 60 * 24 * 30.4375);
}

/** 중앙값 (빈 배열이면 NaN) */
export function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** value가 values 안에서 몇 번째 백분위인지 (0~100, 같은 값은 절반씩 셈) */
export function percentileRank(values, value) {
  const v = values.filter(Number.isFinite);
  if (!v.length || !Number.isFinite(value)) return NaN;
  let below = 0, equal = 0;
  for (const x of v) { if (x < value) below += 1; else if (x === value) equal += 1; }
  return ((below + equal / 2) / v.length) * 100;
}

/**
 * 특정 날짜 이하에서 가장 가까운 점 (없으면 null). points는 날짜순 정렬 가정.
 */
export function pointAt(points, date) {
  let lo = 0, hi = points.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].date <= date) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans < 0 ? null : points[ans];
}

/**
 * 시작일~종료일 필터 (양 끝 포함). 연간(date='YYYY')은 연도 단위로 비교.
 */
export function filterByDate(rows, start, end) {
  return rows.filter((r) => {
    if (r.date.length === 4) {
      return (!start || r.date >= start.slice(0, 4)) && (!end || r.date <= end.slice(0, 4));
    }
    return (!start || r.date >= start) && (!end || r.date <= end);
  });
}

/**
 * 버전 정의로 X/Y 좌표 계산. 계산 불가(NaN/Infinity/null) 행은 제외.
 * @returns {{date:string, x:number, y:number, raw:object}[]}
 */
export function computePoints(rows, version, yAxis) {
  const pts = [];
  for (const r of rows) {
    const x = version.compute(r);
    const y = yAxis.compute(r);
    if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    pts.push({ date: r.date, x, y, raw: r });
  }
  return pts;
}

/** 빈도별 날짜 라벨 */
export function formatDateLabel(date, freq) {
  if (date.length === 4) return `${date}년`;
  const [y, m, d] = date.split('-').map(Number);
  if (freq === 'daily') return `${y}년 ${m}월 ${d}일`;
  if (freq === 'weekly') return `${y}년 ${m}월 ${d}일 주`;
  return `${y}년 ${m}월`;
}

/** Plotly 시간축용 날짜 문자열 (연간 'YYYY' → 'YYYY-07-01' 연중앙) */
export function toAxisDate(date) {
  return date.length === 4 ? `${date}-07-01` : date;
}

/** 요약 카드용 통계 */
export function summarize(points) {
  if (!points.length) return null;
  const first = points[0];
  const last = points[points.length - 1];
  return { count: points.length, first, last };
}

/**
 * NBER USREC(0/1, 월간) 원자료에서 연속된 침체 구간의 [시작,끝] 날짜 목록을 뽑는다.
 * 끝 날짜는 그 달의 말일로 잡는다 (그래프에서 침체 종료월 전체를 덮도록).
 * @param {{date:string, USREC:number|null}[]} rows  월간 정렬 데이터 (USREC 키 포함)
 * @returns {{start:string, end:string}[]}
 */
export function computeRecessionPeriods(rows) {
  const periods = [];
  let open = null;
  for (let i = 0; i < rows.length; i++) {
    const on = rows[i].USREC === 1;
    if (on && !open) open = rows[i].date;
    if (!on && open) { periods.push({ start: open, end: monthEnd(rows[i - 1].date) }); open = null; }
  }
  if (open) periods.push({ start: open, end: monthEnd(rows[rows.length - 1].date) });
  return periods;
}
function monthEnd(date) {
  const [y, m] = date.slice(0, 7).split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

/**
 * 구간별 "이동 속도": 직전 점 대비 (x,y) 변화량을, 표시 중인 전체 범위로 정규화한
 * 유클리드 거리로 환산한다. 값이 클수록 궤적이 빠르게 움직이는 구간이다.
 * 첫 점의 속도는 둘째 점과 동일하게 채워 배열 길이를 points와 맞춘다.
 * @param {{x:number,y:number}[]} points
 * @returns {number[]}
 */
export function computeSpeeds(points) {
  if (points.length < 2) return points.map(() => 0);
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const span = (arr) => Math.max(...arr) - Math.min(...arr) || 1;
  const xSpan = span(xs), ySpan = span(ys);
  const speeds = [0];
  for (let i = 1; i < points.length; i++) {
    const dx = (points[i].x - points[i - 1].x) / xSpan;
    const dy = (points[i].y - points[i - 1].y) / ySpan;
    speeds.push(Math.sqrt(dx * dx + dy * dy));
  }
  speeds[0] = speeds[1] ?? 0;
  return speeds;
}

// ------------------------------------------------------------
// 유사 국면 탐색·전망 계산은 forecast.js 에 있다 (역시 순수 함수).
// ------------------------------------------------------------
