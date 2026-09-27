// ============================================================
// transform.js — 순수 계산 함수 (DOM 없음 → 테스트·확장 용이)
// ============================================================

/**
 * 네 시계열이 같은 날짜에 모두 존재하는 관측치만 남긴다. 날짜 오름차순.
 * @param {Record<string, Map<string, number|null>>} maps
 * @returns {{date:string, BAA:number, AAA:number, GS10:number, GS2:number}[]}
 */
export function alignSeries(maps) {
  const keys = Object.keys(maps);
  const base = maps[keys[0]];
  const rows = [];
  for (const [date, v0] of base) {
    if (v0 === null || !Number.isFinite(v0)) continue;
    const row = { date, [keys[0]]: v0 };
    let ok = true;
    for (let k = 1; k < keys.length; k++) {
      const v = maps[keys[k]].get(date);
      if (v === null || v === undefined || !Number.isFinite(v)) { ok = false; break; }
      row[keys[k]] = v;
    }
    if (ok) rows.push(row);
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return rows;
}

/**
 * 월간 정렬 데이터 → 연평균. date는 'YYYY'. months = 평균에 쓰인 개월 수.
 */
export function aggregateAnnualMean(rows, keys = ['BAA', 'AAA', 'GS10', 'GS2']) {
  const byYear = new Map();
  for (const r of rows) {
    const y = r.date.slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, { n: 0, sums: Object.fromEntries(keys.map((k) => [k, 0])) });
    const g = byYear.get(y);
    g.n += 1;
    for (const k of keys) g.sums[k] += r[k];
  }
  return [...byYear.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([y, g]) => ({
      date: y,
      months: g.n,
      ...Object.fromEntries(keys.map((k) => [k, g.sums[k] / g.n])),
    }));
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

// ------------------------------------------------------------
// [확장 지점] 향후 분석 함수는 여기에 순수 함수로 추가한다.
//  - classifyPhase(points)       : 4단계 국면(#1 위험 ~ #4 둔화) 판정
//  - findSimilarPeriods(points, target, k) : 현재와 비슷한 과거 위치 탐색
//  - pointAt(points, date)       : 특정 날짜의 X/Y 조회
// ------------------------------------------------------------
