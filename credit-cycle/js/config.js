// ============================================================
// config.js — 시리즈·빈도·버전 정의 (새 지표/버전은 여기에 추가)
// ============================================================

/** 데이터 폴더 (index.html 기준 상대경로). 브라우저는 이 폴더만 읽는다. */
export const DATA_PATH = './data/';

/**
 * 빈도별 원천 파일. key(BAA/AAA/GS10/GS2)는 계산식에서 쓰는 공통 이름.
 * 연간(annual)은 월간 파일을 연평균해서 만든다 (별도 파일 없음).
 */
export const FREQUENCIES = {
  daily: {
    label: '일',
    source: 'daily',
    minDate: '1986-01-02',
    files: { BAA: 'DBAA', AAA: 'DAAA', GS10: 'DGS10', GS2: 'DGS2' },
  },
  monthly: {
    label: '월',
    source: 'monthly',
    minDate: '1976-06-01',
    files: { BAA: 'BAA', AAA: 'AAA', GS10: 'GS10', GS2: 'GS2' },
  },
  annual: {
    label: '연',
    source: 'monthly',          // 월간 데이터를 불러와서
    aggregate: 'annualMean',    // 연평균으로 집계
    minDate: '1976-06-01',
    files: { BAA: 'BAA', AAA: 'AAA', GS10: 'GS10', GS2: 'GS2' },
  },
};

export const DEFAULT_FREQ = 'monthly';
export const DEFAULT_VERSION = 'V2';
export const DEFAULT_MARKER_SIZE = 7;

/** 세로축(Y) — 두 버전 공통: 10Y / 2Y */
export const Y_AXIS = {
  label: '10Y / 2Y 국채금리 비율',
  short: '10Y/2Y',
  compute: (r) => (r.GS2 > 0 ? r.GS10 / r.GS2 : null),
  digits: 3,
};

/**
 * 분석 버전. 새 버전(V5 등)은 여기에 객체 하나만 추가하면
 * 선택 메뉴·그래프·카드에 자동 반영된다.
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
};
