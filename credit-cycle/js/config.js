// ============================================================
// config.js — 시리즈·빈도·버전 정의 (새 지표/버전은 여기에 추가)
// ============================================================

/** 데이터 폴더 (index.html 기준 상대경로). 브라우저는 이 폴더만 읽는다. */
export const DATA_PATH = './data/';

/**
 * Y축 계산에 항상 필요한 키. alignSeries()가 이 키들이 모두 있는 날짜만 남기고,
 * 나머지(BAA/AAA/HY 등)는 없으면 null로 채운다 — 그래야 하이일드처럼 시작이
 * 늦은 지표를 추가해도 다른 지표의 과거 구간이 잘리지 않는다.
 */
export const REQUIRED_KEYS = ['GS10', 'GS2'];

/**
 * 빈도별 원천 파일. key는 계산식에서 쓰는 공통 이름.
 * 연간(annual)은 월간 파일을 연평균해서 만든다 (별도 파일 없음).
 * HYM은 FRED에 월평균 변환을 요청해 만든 하이일드 스프레드의 월간판.
 */
export const FREQUENCIES = {
  daily: {
    label: '일',
    source: 'daily',
    minDate: '1986-01-02',
    files: { BAA: 'DBAA', AAA: 'DAAA', GS10: 'DGS10', GS2: 'DGS2', HY: 'HY' },
  },
  monthly: {
    label: '월',
    source: 'monthly',
    minDate: '1976-06-01',
    files: { BAA: 'BAA', AAA: 'AAA', GS10: 'GS10', GS2: 'GS2', HY: 'HYM' },
  },
  annual: {
    label: '연',
    source: 'monthly',          // 월간 데이터를 불러와서
    aggregate: 'annualMean',    // 연평균으로 집계
    minDate: '1976-06-01',
    files: { BAA: 'BAA', AAA: 'AAA', GS10: 'GS10', GS2: 'GS2', HY: 'HYM' },
  },
};

/** 경기침체 음영(USREC)은 빈도와 무관하게 항상 월간 원자료 하나만 불러와 쓴다. */
export const RECESSION_FILE = { USREC: 'USREC' };

export const DEFAULT_FREQ = 'monthly';
export const DEFAULT_VERSION = 'V2';
export const DEFAULT_MARKER_SIZE = 7;

/** 세로축(Y) — 모든 버전 공통: 10Y / 2Y */
export const Y_AXIS = {
  label: '10Y / 2Y 국채금리 비율',
  short: '10Y/2Y',
  compute: (r) => (r.GS2 > 0 ? r.GS10 / r.GS2 : null),
  digits: 3,
};

/**
 * 분석 버전. 새 버전을 추가하려면 여기에 객체 하나만 추가하면
 * 선택 메뉴·그래프·카드에 자동 반영된다.
 * minDate가 있으면 그 이전 구간은 이 버전에서 데이터가 없다는 뜻 — 날짜를
 * 강제로 바꾸지는 않고, 실제 표시되는 첫 시점이 자연히 그 이후가 된다.
 */
export const VERSIONS = {
  V2: {
    label: 'V2 — Baa−10Y × 10Y/2Y',
    xLabel: 'Baa − 10Y Treasury (%p)',
    xShort: 'Baa−10Y',
    compute: (r) => r.BAA - r.GS10,
    digits: 2,
  },
  V4: {
    label: 'V4 — Baa/Aaa × 10Y/2Y',
    xLabel: 'Baa / Aaa 회사채 수익률 비율',
    xShort: 'Baa/Aaa',
    compute: (r) => (r.AAA > 0 ? r.BAA / r.AAA : null),
    digits: 3,
  },
  V6: {
    label: 'V6 — 하이일드 스프레드 × 10Y/2Y',
    xLabel: 'ICE BofA US 하이일드 OAS (%)',
    xShort: 'HY OAS',
    compute: (r) => (r.HY === null || r.HY === undefined ? null : r.HY),
    digits: 2,
    minDate: '1996-12-31',
    note: 'ICE BofA US High Yield 지수의 옵션조정스프레드(OAS)입니다. FRED가 2026년 4월부터 이 시리즈를 최근 3년치만 공개해서, 실제로 표시되는 기간은 그보다 짧을 수 있습니다.',
  },
};
