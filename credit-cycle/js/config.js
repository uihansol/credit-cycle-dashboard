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
    stepsPerMonth: 21,          // 영업일 기준 한 달 ≈ 21개 관측치 (전망 기간 환산용)
    files: { BAA: 'DBAA', AAA: 'DAAA', GS10: 'DGS10', GS2: 'DGS2', HY: 'HY' },
  },
  weekly: {
    label: '주',
    source: 'daily',            // 일간 데이터를 불러와서
    aggregate: 'weeklyMean',    // 주(월~일, 금요일 마감) 평균으로 집계
    minDate: '1986-01-02',
    stepsPerMonth: 52 / 12,
    files: { BAA: 'DBAA', AAA: 'DAAA', GS10: 'DGS10', GS2: 'DGS2', HY: 'HY' },
  },
  monthly: {
    label: '월',
    source: 'monthly',
    minDate: '1976-06-01',
    stepsPerMonth: 1,
    files: { BAA: 'BAA', AAA: 'AAA', GS10: 'GS10', GS2: 'GS2', HY: 'HYM' },
  },
  annual: {
    label: '연',
    source: 'monthly',          // 월간 데이터를 불러와서
    aggregate: 'annualMean',    // 연평균으로 집계
    minDate: '1976-06-01',
    stepsPerMonth: 1 / 12,
    files: { BAA: 'BAA', AAA: 'AAA', GS10: 'GS10', GS2: 'GS2', HY: 'HYM' },
  },
};

/** 경기침체 음영(USREC)은 빈도와 무관하게 항상 월간 원자료 하나만 불러와 쓴다. */
export const RECESSION_FILE = { USREC: 'USREC' };

export const DEFAULT_FREQ = 'monthly';
export const DEFAULT_VERSION = 'V2';
export const DEFAULT_MARKER_SIZE = 7;
export const DEFAULT_Y_AXIS = 'spread';

/**
 * 세로축(Y) — 장단기 금리 구조. 모든 버전 공통으로 두 가지 중 고른다.
 *  - inversion: 장단기 역전 기준값 (비율이면 1, 금리차면 0). 역전선·4단계 국면의 경계로 쓴다.
 *  - deltaMode: 전망 경로를 만들 때 과거 변화를 현재 값에 적용하는 방식.
 *      'mul' = 비율로(로그 변화) 적용, 'add' = 차이로 적용.
 *    10Y/2Y 비율은 금리 수준이 낮을 때(2Y≈0) 값이 크게 튀므로 비율 변화로 옮겨야 자연스럽다.
 */
export const Y_AXES = {
  // 기본값은 금리차(spread): 비율은 2Y≈0이던 2011~2021년에 10 가까이 튀어 최근 구간이 눌려 보인다.
  ratio: {
    label: '10Y / 2Y 국채금리 비율',
    short: '10Y/2Y',
    menu: '10Y/2Y 비율',
    compute: (r) => (r.GS2 > 0 ? r.GS10 / r.GS2 : null),
    digits: 3,
    inversion: 1,
    deltaMode: 'mul',
  },
  spread: {
    label: '10Y − 2Y 장단기 금리차 (%p)',
    short: '10Y−2Y',
    menu: '10Y−2Y 금리차',
    compute: (r) => r.GS10 - r.GS2,
    digits: 2,
    inversion: 0,
    deltaMode: 'add',
  },
};

/** 예전 코드 호환용: 기본 세로축 */
export const Y_AXIS = Y_AXES.ratio;

/**
 * 전망(유사 국면 기반) 설정.
 *  - horizons: 전망 기간 선택지(개월)
 *  - analogs: 참고할 과거 유사 시점 개수
 *  - lookbackMonths: "최근 흐름(모멘텀)"을 잴 기간
 *  - separationMonths: 유사 시점끼리 최소 간격 (같은 에피소드가 여러 번 뽑히지 않게)
 *  - momentumWeight: 위치 대비 최근 흐름의 가중치
 */
export const FORECAST = {
  horizons: [6, 12, 24],
  defaultHorizon: 12,
  analogs: 10,
  lookbackMonths: 6,
  separationMonths: 12,
  momentumWeight: 0.8,
};

/**
 * 분석 버전. 새 버전을 추가하려면 여기에 객체 하나만 추가하면
 * 선택 메뉴·그래프·카드에 자동 반영된다.
 * minDate가 있으면 그 이전 구간은 이 버전에서 데이터가 없다는 뜻 — 날짜를
 * 강제로 바꾸지는 않고, 실제 표시되는 첫 시점이 자연히 그 이후가 된다.
 */
export const VERSIONS = {
  V2: {
    label: 'V2 — Baa−10Y',
    menu: 'Baa−10Y',
    xLabel: 'Baa − 10Y Treasury (%p)',
    xShort: 'Baa−10Y',
    compute: (r) => r.BAA - r.GS10,
    digits: 2,
    unit: '%p',
    deltaMode: 'add',
  },
  V4: {
    label: 'V4 — Baa/Aaa',
    menu: 'Baa/Aaa',
    xLabel: 'Baa / Aaa 회사채 수익률 비율',
    xShort: 'Baa/Aaa',
    compute: (r) => (r.AAA > 0 ? r.BAA / r.AAA : null),
    digits: 3,
    unit: '',
    deltaMode: 'add',
  },
  V6: {
    label: 'V6 — 하이일드 OAS',
    menu: '하이일드 OAS',
    xLabel: 'ICE BofA US 하이일드 OAS (%)',
    xShort: 'HY OAS',
    compute: (r) => (r.HY === null || r.HY === undefined ? null : r.HY),
    digits: 2,
    unit: '%',
    deltaMode: 'mul',            // 하이일드 스프레드는 수준이 높을수록 변동도 커서 비율 변화로 옮긴다
    minDate: '1996-12-31',
    // 자체 이력이 짧으면(FRED 3년 공개 제한) 전망·백분위 계산에 V2(Baa−10Y) 장기 이력을
    // 겹치는 기간 회귀로 하이일드 척도로 환산해 앞에 이어 붙인다. 화면에는 실제 값만 그린다.
    proxy: 'V2',
    note: 'ICE BofA US High Yield 지수의 옵션조정스프레드(OAS)입니다. FRED가 2026년 4월부터 이 시리즈를 최근 3년치만 공개해서, 실제로 표시되는 기간은 그보다 짧을 수 있습니다.',
  },
};
