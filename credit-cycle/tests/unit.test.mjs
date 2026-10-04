// 순수 함수 유닛 테스트 — 실행: credit-cycle 폴더에서 `node --test tests/`
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  alignSeries, aggregateAnnualMean, aggregateWeeklyMean, weekEnding, addSteps, filterByDate,
  computePoints, formatDateLabel, computeRecessionPeriods, computeSpeeds, median, percentileRank, pointAt,
  spliceWithOffset,
} from '../js/transform.js';
import {
  classifyPhase, stepsFor, spliceProxyHistory, findAnalogs, projectFromAnalogs, summarizeProjection,
  diagnose, ellipsePath, recessionWithin, robustScale,
} from '../js/forecast.js';
import { buildOverlays } from '../js/overlays.js';
import { parseFredCsv } from '../js/data-loader.js';
import { detectRepo, getToken, setToken, runServerUpdate, RefreshError } from '../js/server-refresh.js';
import { VERSIONS, Y_AXES, FREQUENCIES, REQUIRED_KEYS, OPTIONAL_KEYS } from '../js/config.js';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'data');

// ------------------------------------------------------------ transform
test('alignSeries: required만 필수, optional은 null로 채움 (과거 구간 유지)', () => {
  const maps = {
    GS10: new Map([['2000-01-01', 6], ['2000-02-01', 6.1]]),
    GS2: new Map([['2000-01-01', 5], ['2000-02-01', 5.2]]),
    HY: new Map([['2000-02-01', 4]]),
  };
  const rows = alignSeries(maps, ['GS10', 'GS2']);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].HY, null);
  assert.equal(rows[1].HY, 4);
});

test('weekEnding: 월~일 주의 금요일', () => {
  assert.equal(weekEnding('2026-09-21'), '2026-09-25'); // 월
  assert.equal(weekEnding('2026-09-25'), '2026-09-25'); // 금
  assert.equal(weekEnding('2026-09-26'), '2026-09-25'); // 토
  assert.equal(weekEnding('2026-09-27'), '2026-09-25'); // 일
  assert.equal(weekEnding('2026-09-28'), '2026-10-02'); // 다음 월
});

test('aggregateWeeklyMean: 주평균, date=그 주 마지막 관측일, 결측은 건너뜀', () => {
  const rows = [
    { date: '2026-09-21', GS10: 4, GS2: 3, HY: null },
    { date: '2026-09-22', GS10: 5, GS2: 3, HY: 2 },
    { date: '2026-09-28', GS10: 6, GS2: 4, HY: 3 },
  ];
  const w = aggregateWeeklyMean(rows, ['GS10', 'GS2', 'HY']);
  assert.equal(w.length, 2);
  assert.equal(w[0].date, '2026-09-22');
  assert.equal(w[0].GS10, 4.5);
  assert.equal(w[0].HY, 2);
  assert.equal(w[0].days, 2);
  assert.equal(w[1].date, '2026-09-28');
});

test('aggregateAnnualMean: 연평균 (회귀)', () => {
  const rows = [
    { date: '2000-01-01', GS10: 6, GS2: 5, BAA: 8, AAA: 7, HY: null },
    { date: '2000-02-01', GS10: 8, GS2: 5, BAA: 8, AAA: 7, HY: null },
  ];
  const a = aggregateAnnualMean(rows);
  assert.equal(a[0].date, '2000');
  assert.equal(a[0].GS10, 7);
  assert.equal(a[0].HY, null);
  assert.equal(a[0].months, 2);
});

test('addSteps: 빈도별 미래 날짜', () => {
  assert.equal(addSteps('2026-08-01', 'monthly', 12), '2027-08-01');
  assert.equal(addSteps('2026-09-25', 'weekly', 1), '2026-10-02');
  assert.equal(addSteps('2026-09-25', 'daily', 1), '2026-09-28'); // 금 → 월
  assert.equal(addSteps('2026', 'annual', 2), '2028');
});

test('formatDateLabel: 주간 라벨', () => {
  assert.equal(formatDateLabel('2026-09-25', 'weekly'), '2026년 9월 25일 주');
  assert.equal(formatDateLabel('2026-09-01', 'monthly'), '2026년 9월');
  assert.equal(formatDateLabel('2026', 'annual'), '2026년');
});

test('filterByDate / pointAt / median / percentileRank', () => {
  const pts = [{ date: '2000-01-01', x: 1 }, { date: '2000-02-01', x: 2 }, { date: '2000-03-01', x: 3 }];
  assert.equal(filterByDate(pts, '2000-02-01', '2000-03-01').length, 2);
  assert.equal(pointAt(pts, '2000-02-15').x, 2);
  assert.equal(pointAt(pts, '1999-12-31'), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(percentileRank([1, 2, 3, 4], 4), 87.5);
});

test('computeRecessionPeriods / computeSpeeds (회귀)', () => {
  const rows = [
    { date: '2001-02-01', USREC: 0 }, { date: '2001-03-01', USREC: 1 },
    { date: '2001-04-01', USREC: 1 }, { date: '2001-05-01', USREC: 0 },
  ];
  assert.deepEqual(computeRecessionPeriods(rows), [{ start: '2001-03-01', end: '2001-04-30' }]);
  const sp = computeSpeeds([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]);
  assert.equal(sp.length, 3);
  assert.equal(sp[0], sp[1]);
});

test('Y_AXES: 비율·금리차 계산과 역전 기준', () => {
  const r = { GS10: 4, GS2: 5 };
  assert.equal(Y_AXES.ratio.compute(r), 0.8);
  assert.equal(Y_AXES.spread.compute(r), -1);
  assert.equal(Y_AXES.ratio.inversion, 1);
  assert.equal(Y_AXES.spread.inversion, 0);
});

// ------------------------------------------------------------ forecast
test('classifyPhase: 4분면', () => {
  assert.equal(classifyPhase(3, 0.9, 2, 1), 'danger');
  assert.equal(classifyPhase(3, 1.2, 2, 1), 'recovery');
  assert.equal(classifyPhase(1, 1.2, 2, 1), 'expansion');
  assert.equal(classifyPhase(1, 0.9, 2, 1), 'slowdown');
});

test('stepsFor: 빈도별 개월 → 단계', () => {
  assert.equal(stepsFor(FREQUENCIES.monthly, 12), 12);
  assert.equal(stepsFor(FREQUENCIES.daily, 12), 252);
  assert.equal(stepsFor(FREQUENCIES.weekly, 12), 52);
  assert.equal(stepsFor(FREQUENCIES.annual, 12), 1);
  assert.equal(stepsFor(FREQUENCIES.annual, 6), 1);
});

/** 주기 60단계 원운동 궤적 — 유사 시점은 정확히 한 주기 전들이어야 한다. */
function circle(n, period = 60) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / period;
    const yy = 2000 + Math.floor(i / 12), mm = (i % 12) + 1;
    out.push({ date: `${yy}-${String(mm).padStart(2, '0')}-01`, x: 2 + Math.cos(t), y: 1 + 0.5 * Math.sin(t) });
  }
  return out;
}

test('findAnalogs: 주기 궤적에서 같은 위상의 과거 시점을 찾고, 미래 누설이 없다', () => {
  const h = circle(360);
  const ci = 359;
  const an = findAnalogs(h, ci, { horizon: 12, lookback: 6, separation: 12, count: 4 });
  assert.equal(an.length, 4);
  for (const a of an) {
    assert.equal((ci - a.index) % 60, 0, `위상 불일치: ${a.index}`);
    assert.ok(a.index + 12 <= ci);
    assert.ok(a.distance < 1e-9);
  }
  // 최소 간격
  const idx = an.map((a) => a.index).sort((a, b) => a - b);
  for (let i = 1; i < idx.length; i++) assert.ok(idx[i] - idx[i - 1] >= 12);
});

test('projectFromAnalogs: 완전 주기 궤적이면 예상 경로 = 실제 다음 경로', () => {
  const h = circle(420);
  const ci = 359;
  const an = findAnalogs(h, ci, { horizon: 12, lookback: 6, separation: 12, count: 5 });
  const proj = projectFromAnalogs(h, ci, an, { horizon: 12 });
  assert.equal(proj.mean.length, 13);
  for (let s = 0; s <= 12; s++) {
    assert.ok(Math.abs(proj.mean[s].x - h[ci + s].x) < 1e-9);
    assert.ok(Math.abs(proj.mean[s].y - h[ci + s].y) < 1e-9);
  }
  const w = proj.weights.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(w - 1) < 1e-12);
  const sum = summarizeProjection(proj, { xSplit: 2, yInversion: 1, horizonMonths: 12 });
  const total = Object.values(sum.probs).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
  assert.equal(sum.toPhase, classifyPhase(h[ci + 12].x, h[ci + 12].y, 2, 1));
});

test('projectFromAnalogs: mul 모드는 비율 변화로 옮긴다', () => {
  const h = [
    { date: '2000-01-01', x: 1, y: 1 }, { date: '2000-02-01', x: 2, y: 2 },
    { date: '2000-03-01', x: 4, y: 4 },
  ];
  const proj = projectFromAnalogs(h, 2, [{ index: 0, distance: 0, date: '2000-01-01' }], { horizon: 1, modeX: 'mul', modeY: 'add' });
  assert.ok(Math.abs(proj.mean[1].x - 8) < 1e-9); // 4 × (2/1)
  assert.ok(Math.abs(proj.mean[1].y - 5) < 1e-9); // 4 + (2-1)
});

test('spliceProxyHistory: 겹치는 구간 회귀로 앞부분을 환산', () => {
  const proxy = [], own = [];
  for (let i = 0; i < 40; i++) {
    const date = `${2000 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-01`;
    const px = 1 + 0.05 * i + 0.3 * Math.sin(i);
    proxy.push({ date, x: px, y: 1 });
    if (i >= 20) own.push({ date, x: 0.5 + 3 * px, y: 1 });
  }
  const res = spliceProxyHistory(own, proxy, { mode: 'add', minOverlap: 12 });
  assert.equal(res.points.length, 40);
  assert.ok(res.points[0].proxied);
  assert.ok(!res.points[25].proxied);
  assert.ok(Math.abs(res.fit.b - 3) < 1e-9);
  assert.ok(Math.abs(res.fit.a - 0.5) < 1e-9);
  assert.ok(Math.abs(res.points[0].x - (0.5 + 3 * proxy[0].x)) < 1e-9);
  assert.ok(res.fit.r2 > 0.999);
  // 겹침이 부족하면 보완하지 않음
  assert.equal(spliceProxyHistory(own.slice(-5), proxy, { minOverlap: 12 }).fit, null);
});

test('ellipsePath / robustScale / recessionWithin', () => {
  const e = ellipsePath({ cx: 0, cy: 0, sxx: 1, syy: 1, sxy: 0 }, 1, 8);
  assert.ok(e.x.every((x, i) => Math.abs(Math.hypot(x, e.y[i]) - 1) < 1e-9));
  assert.ok(robustScale([1, 1, 1, 1]) === 1);
  const periods = [{ start: '2008-01-01', end: '2009-06-30' }];
  assert.equal(recessionWithin('2007-06-01', 12, periods), true);
  assert.equal(recessionWithin('2005-01-01', 12, periods), false);
  assert.equal(recessionWithin('2009-07-01', 12, periods), false);
});

test('diagnose: 역전 상태·흐름 판정', () => {
  const h = [];
  for (let i = 0; i < 60; i++) {
    h.push({ date: `${2000 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-01`, x: 2 + i * 0.01, y: 1.3 - i * 0.01 });
  }
  const d = diagnose(h, 59, { xSplit: 2.2, yInversion: 1, stepsPerMonth: 1 });
  assert.equal(d.inverted, true);
  assert.equal(d.phase, 'danger');
  assert.ok(d.signals.some((s) => s.text.includes('역전')));
  assert.equal(d.flow.months, 3);
});

// ------------------------------------------------------------ overlays
test('buildOverlays: 국면 배경은 xSplit·yInversion을 경계로, 전망 트레이스 포함', () => {
  const h = circle(420);
  const pts = h.slice(0, 360);
  const an = findAnalogs(h, 359, { horizon: 12, lookback: 6, separation: 12, count: 5 });
  const proj = projectFromAnalogs(h, 359, an, { horizon: 12 });
  const o = buildOverlays(pts, {
    freq: 'monthly', features: { phases: true, forecast: true, recent: true, arrows: true },
    xSplit: 2.1, yInversion: 1, projection: proj, recentSteps: 12, horizonLabel: '1년',
  });
  const rects = o.shapes.filter((s) => s.type === 'rect');
  assert.equal(rects.length, 4);
  assert.ok(rects.some((r) => r.x1 === 2.1));
  assert.ok(rects.some((r) => r.y0 === 1 || r.y1 === 1));
  assert.ok(o.traces.some((t) => (t.name || '').startsWith('예상 경로')));
  assert.ok(o.traces.some((t) => (t.name || '').includes('최근')));
  assert.ok(o.annotations.some((a) => a.showarrow));
  // 끄면 아무것도 없음
  const off = buildOverlays(pts, { features: {}, projection: proj });
  assert.equal(off.traces.length + off.shapes.length + off.annotations.length, 0);
});

// ------------------------------------------------------------ 실제 데이터로 스모크 테스트
function loadMaps(files) {
  const out = {};
  for (const [k, id] of Object.entries(files)) {
    // 선택 시리즈(BBB 등)는 파일이 아직 없을 수 있다 — 앱과 똑같이 빈 Map으로 취급
    if (OPTIONAL_KEYS.includes(k) && !existsSync(join(dataDir, `${id}.csv`))) { out[k] = new Map(); continue; }
    out[k] = parseFredCsv(readFileSync(join(dataDir, `${id}.csv`), 'utf8'), `${id}.csv`);
  }
  return out;
}

test('실데이터: 모든 빈도·버전·세로축에서 전망이 계산된다', () => {
  for (const [fk, cfg] of Object.entries(FREQUENCIES)) {
    let rows = alignSeries(loadMaps(cfg.files), REQUIRED_KEYS).filter((r) => r.date >= cfg.minDate);
    const keys = Object.keys(cfg.files);
    for (const v of Object.values(VERSIONS)) {
      if (v.splice) { spliceWithOffset(rows, v.splice.key, v.splice.proxy, v.splice.out); keys.push(v.splice.out); }
    }
    if (cfg.aggregate === 'weeklyMean') rows = aggregateWeeklyMean(rows, keys);
    if (cfg.aggregate === 'annualMean') rows = aggregateAnnualMean(rows, keys);
    assert.ok(rows.length > 40, `${fk} 행 수`);
    for (const [vk, v] of Object.entries(VERSIONS)) {
      for (const [yk, y] of Object.entries(Y_AXES)) {
        const own = computePoints(rows, v, y);
        if (v.needs && !own.length) continue; // 데이터 파일이 아직 없는 선택 지표
        let hist = own;
        if (v.proxy) {
          hist = spliceProxyHistory(own, computePoints(rows, VERSIONS[v.proxy], y),
            { mode: v.deltaMode, minOverlap: Math.max(3, stepsFor(cfg, 12)) }).points;
        }
        const ci = hist.length - 1;
        const H = stepsFor(cfg, fk === 'annual' ? 24 : 12);
        const an = findAnalogs(hist, ci, {
          horizon: H, lookback: stepsFor(cfg, 6), separation: stepsFor(cfg, 12), count: 10,
          modeX: v.deltaMode, modeY: y.deltaMode,
        });
        assert.ok(an.length >= 3, `${fk}/${vk}/${yk}: 유사 시점 ${an.length}개`);
        const proj = projectFromAnalogs(hist, ci, an, { horizon: H, modeX: v.deltaMode, modeY: y.deltaMode });
        assert.ok(proj.mean.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)), `${fk}/${vk}/${yk}: 경로 유한`);
      }
    }
  }
});

test('실데이터: 주간 빈도는 일간과 같은 최신일로 끝난다', () => {
  const cfg = FREQUENCIES.weekly;
  const daily = alignSeries(loadMaps(cfg.files), REQUIRED_KEYS).filter((r) => r.date >= cfg.minDate);
  const weekly = aggregateWeeklyMean(daily);
  assert.equal(weekly[weekly.length - 1].date, daily[daily.length - 1].date);
  assert.ok(weekly.length > daily.length / 6 && weekly.length < daily.length / 4);
});

test('spliceWithOffset: 겹치는 구간 중앙값 차이로 앞쪽을 이어 붙인다', () => {
  const rows = [];
  for (let i = 0; i < 30; i++) {
    rows.push({ date: `20${String(10 + Math.floor(i / 12)).padStart(2, '0')}-${String((i % 12) + 1).padStart(2, '0')}-01`,
      BAA: 6 + 0.1 * i, GS10: 4, BBB: i >= 15 ? (2 + 0.1 * i) - 0.7 : null });
  }
  const res = spliceWithOffset(rows, 'BBB', (r) => r.BAA - r.GS10, 'BBBL');
  assert.ok(Math.abs(res.offset - 0.7) < 1e-9);
  assert.equal(res.overlap, 15);
  assert.equal(res.realStart, rows[15].date);
  assert.ok(rows[0].BBBL_proxied && !rows[20].BBBL_proxied);
  assert.ok(Math.abs(rows[0].BBBL - (2 - 0.7)) < 1e-9);
  assert.equal(rows[20].BBBL, rows[20].BBB);
  // 겹침이 부족하면 환산하지 않음
  const few = rows.map((r, i) => ({ ...r, BBB: i >= 25 ? 1 : null }));
  const r2 = spliceWithOffset(few, 'BBB', (r) => r.BAA - r.GS10, 'BBBL');
  assert.equal(r2.offset, null);
  assert.equal(few[0].BBBL, null);
  assert.equal(few[26].BBBL, 1);
});

test('V7(BBB): 이어 붙인 BBBL을 X로 쓰고, BBB 파일이 없으면 V7만 비고 다른 버전은 그대로', () => {
  assert.equal(VERSIONS.V7.compute({ BBBL: null }), null);
  assert.equal(VERSIONS.V7.compute({ BBBL: 1.7 }), 1.7);
  assert.ok(OPTIONAL_KEYS.includes(VERSIONS.V7.needs));
  const maps = {
    GS10: new Map([['2000-01-01', 6]]), GS2: new Map([['2000-01-01', 5]]),
    BAA: new Map([['2000-01-01', 8]]), BBB: new Map(),
  };
  const rows = alignSeries(maps, REQUIRED_KEYS);
  spliceWithOffset(rows, 'BBB', VERSIONS.V7.splice.proxy, 'BBBL');
  assert.equal(computePoints(rows, VERSIONS.V7, Y_AXES.ratio).length, 0);
  assert.equal(computePoints(rows, VERSIONS.V2, Y_AXES.ratio).length, 1);
});

test('aggregateWeeklyMean / aggregateAnnualMean: BBB 키도 집계된다', () => {
  const rows = [
    { date: '2026-09-21', GS10: 4, GS2: 3, BBB: 1.0 },
    { date: '2026-09-22', GS10: 5, GS2: 3, BBB: 2.0 },
  ];
  assert.equal(aggregateWeeklyMean(rows, ['GS10', 'GS2', 'BBB'])[0].BBB, 1.5);
  assert.equal(aggregateAnnualMean(rows, ['GS10', 'GS2', 'BBB'])[0].BBB, 1.5);
});

test('실데이터: V7(BBB)은 이어 붙여 10년 이상 이력을 갖는다', () => {
  for (const fk of ['daily', 'monthly']) {
    const cfg = FREQUENCIES[fk];
    const rows = alignSeries(loadMaps(cfg.files), REQUIRED_KEYS).filter((r) => r.date >= cfg.minDate);
    const sp = spliceWithOffset(rows, 'BBB', VERSIONS.V7.splice.proxy, 'BBBL');
    const pts = computePoints(rows, VERSIONS.V7, Y_AXES.spread);
    const years = (Date.parse(pts[pts.length - 1].date) - Date.parse(pts[0].date)) / 3.156e10;
    assert.ok(sp.offset !== null, `${fk} offset`);
    assert.ok(years > 30, `${fk}: ${years.toFixed(1)}년`);
  }
});

// ------------------------------------------------------------ 서버 갱신 (GitHub Actions 호출) — fetch 모의
function mockGithub({ sequence, headShas = ['aaa', 'aaa'], dispatchStatus = 204, runsStatus = 200 }) {
  const calls = [];
  let runsCall = 0, shaCall = 0;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', auth: init.headers?.Authorization });
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (/\/dispatches$/.test(url)) return json(dispatchStatus, null);
    if (/\/runs\?/.test(url)) {
      if (runsStatus !== 200) return json(runsStatus, {});
      const r = sequence[Math.min(runsCall++, sequence.length - 1)];
      return json(200, { workflow_runs: r });
    }
    if (/\/commits\//.test(url)) return json(200, { sha: headShas[Math.min(shaCall++, headShas.length - 1)] });
    return json(404, {});
  };
  return calls;
}
const run = (id, status, conclusion) => ({ id, status, conclusion, html_url: `https://x/runs/${id}` });
const FAST = { intervalMs: 1, timeoutMs: 2000, repo: 'o/r' };

test('detectRepo: github.io 주소에서 저장소 추정', () => {
  assert.equal(detectRepo({ hostname: 'uihansol.github.io', pathname: '/credit-cycle-dashboard/credit-cycle/' }), 'uihansol/credit-cycle-dashboard');
  assert.equal(detectRepo({ hostname: 'localhost', pathname: '/' }, 'a/b'), 'a/b');
});

test('토큰 저장소가 없는 환경(Node)에서도 예외 없이 빈 값', () => {
  assert.equal(getToken(), '');
  assert.equal(setToken('x'), false);
});

test('runServerUpdate: 새 실행을 추적하고, 새 커밋이 생겼으면 dataChanged=true', async () => {
  const calls = mockGithub({ sequence: [[run(5, 'completed', 'success')], [run(5, 'completed', 'success')], [run(6, 'queued', null), run(5, 'completed', 'success')], [run(6, 'in_progress', null)], [run(6, 'completed', 'success')]], headShas: ['old', 'new'] });
  const seen = [];
  const r = await runServerUpdate('tok', { ...FAST, onStatus: (m) => seen.push(m) });
  assert.equal(r.dataChanged, true);
  assert.equal(r.runUrl, 'https://x/runs/6');
  assert.ok(calls.some((c) => c.method === 'POST' && /dispatches$/.test(c.url)));
  assert.ok(calls.every((c) => c.auth === 'Bearer tok'));
  assert.ok(seen.length >= 2);
});

test('runServerUpdate: 새 데이터가 없으면 dataChanged=false', async () => {
  mockGithub({ sequence: [[run(5, 'completed', 'success')], [run(5, 'completed', 'success')], [run(6, 'completed', 'success'), run(5, 'completed', 'success')]], headShas: ['same', 'same'] });
  assert.equal((await runServerUpdate('tok', FAST)).dataChanged, false);
});

test('runServerUpdate: 오래된 실행(기준선 이하)은 새 실행으로 오인하지 않는다', async () => {
  mockGithub({ sequence: [[run(5, 'completed', 'success')]] });
  await assert.rejects(runServerUpdate('tok', { ...FAST, timeoutMs: 40 }), /제한 시간/);
});

test('runServerUpdate: 실패한 실행 / 권한 오류를 구분해 알린다', async () => {
  mockGithub({ sequence: [[run(5, 'completed', 'success')], [run(5, 'completed', 'success')], [run(6, 'completed', 'failure')]] });
  await assert.rejects(runServerUpdate('tok', FAST), (e) => e instanceof RefreshError && /실패/.test(e.message) && e.url === 'https://x/runs/6');
  mockGithub({ sequence: [[]], dispatchStatus: 403 });
  await assert.rejects(runServerUpdate('tok', FAST), (e) => e.auth === true && /권한/.test(e.message));
  mockGithub({ sequence: [[]], runsStatus: 401 });
  await assert.rejects(runServerUpdate('bad', FAST), (e) => e.auth === true && /토큰/.test(e.message));
});
