# 미국 금리·신용 사이클 탐색기

```
FRED → GitHub Actions → credit-cycle/data/*.csv → GitHub Pages → 브라우저
```
브라우저는 `./data/*.csv`와 `./data/meta.json`만 읽습니다. FRED 직접 접속·CORS 프록시·외부 데이터 API는 쓰지 않습니다.
(외부에서 받는 것은 그래프 라이브러리 Plotly와 Pretendard 글꼴뿐입니다.)

## 파일 구조
```
(repository root)
├── .nojekyll
├── .github/workflows/update-fred-credit-cycle.yml   # 평일 자동 + 수동 + push 시 실행
└── credit-cycle/
    ├── index.html
    ├── css/style.css
    ├── js/
    │   ├── config.js        # 시리즈·빈도(일/주/월/연)·버전(V2/V4/V6/V7)·세로축·전망 설정  ← 새 버전/지표 추가
    │   ├── data-loader.js   # ./data/*.csv 읽기·파싱·오류 수집
    │   ├── transform.js     # 정렬·결측 제거·주평균/연평균·기간 필터·X/Y 계산·침체 구간·이동 속도 (순수 함수)
    │   ├── forecast.js      # 유사 국면 탐색·전망 경로·국면 가능성·현재 진단 (순수 함수)
    │   ├── charts.js        # Plotly 그래프 렌더링 (궤적/시계열, 침체 음영, 전망 부채꼴, 색상 모드)
    │   ├── overlays.js      # 궤적 위 덧그리기 — 4단계 국면 배경, 주요 시기, 흐름 화살표, 최근 흐름, 전망 경로
    │   └── app.js           # 상태·컨트롤 연결 (진단 카드, 전망 패널, 흐름 재생, 주소 공유)
    ├── tests/unit.test.mjs  # 순수 함수 유닛 테스트 (`node --test tests/unit.test.mjs`)
    ├── scripts/update_fred.py   # Actions가 실행하는 다운로드·병합 스크립트
    ├── scripts/stamp_assets.py  # js/css 캐시 무효화용 ?v=해시를 index.html에 기록
    └── data/   # Actions가 채움: BAA/AAA/GS10/GS2, DBAA/DAAA/DGS10/DGS2, HY/HYM(하이일드 OAS), BBB/BBBM(BBB 회사채 OAS), VIX/VIXM(변동성 지수), USREC(침체 판정) + meta.json
```

## 1. 올리기
위 구조 그대로 저장소 루트에 올립니다 (`.github` 폴더는 반드시 **저장소 루트**에 있어야 합니다).
기본 브랜치가 `main`이 아니면 workflow의 `branches: [main]`을 바꿔 주세요.

## 2. GitHub Actions 쓰기 권한 켜기
Settings → Actions → General
- Actions permissions: **Allow all actions**
- Workflow permissions: **Read and write permissions** → Save

## 3. 첫 데이터 받기
Actions 탭 → **Update FRED data (credit-cycle)** → **Run workflow**.
첫 실행은 전체 기간(월간 1976-06-01~, 일간 1986-01-02~, 하이일드 OAS 1996-12-31~, 침체판정 1976~)을 받고 `credit-cycle/data/`에 커밋합니다 (1~2분).
이후에는 평일 하루 두 번 — UTC 02:15(한국 11:15)와 UTC 22:00(한국 07:00) — 최근 120일만 다시 받아 병합합니다. FRED의 일간 금리는 Fed H.15 발표(미국 동부 16:15 = UTC 20:15/21:15) 직후에 올라오므로, 22:00 실행이 당일 발표분을 바로 받아 옵니다(02:15 한 번만 받으면 최신 관측일이 항상 하루 더 늦습니다). 같은 날짜는 새 값이 우선이라 FRED 수정치도 반영됩니다.

수동 실행 옵션: `full_refresh`(전체 재다운로드), `lookback_days`(증분 기간).

> **하이일드 스프레드(V6)에 대한 안내**: FRED가 2026년 4월부터 `BAMLH0A0HYM2`(ICE BofA US High Yield OAS) 시리즈를
> 최근 3년치만 공개하도록 정책을 바꿨습니다. 그래서 V6 버전은 다른 버전과 달리 최근 몇 년치만 궤적에 나타납니다.
> 대시보드에도 이 안내가 버전 선택 아래에 자동으로 표시됩니다.

### (선택) FRED API 키
fredgraph.csv가 러너에서 막히거나 느리면 무료 FRED API 키를 발급받아
Settings → Secrets and variables → Actions → New repository secret → 이름 `FRED_API_KEY`로 등록하세요. 스크립트가 자동으로 공식 API를 씁니다.

## 4. GitHub Pages 배포
Settings → Pages → Source: **Deploy from a branch** → Branch `main` / `(root)` → Save.
주소: `https://USERNAME.github.io/REPOSITORY/credit-cycle/`

## 5. 업데이트 확인
- Actions 탭: 실행 기록이 초록색인지, 로그의 `저장: 유효값 N개, 시작 ~ 끝` 줄
- 커밋 기록: `data: update FRED credit-cycle series (날짜)` 커밋 (변화가 없으면 커밋하지 않음)
- `credit-cycle/data/meta.json`: `updated_at`과 시리즈별 `last` 날짜
- 대시보드 맨 아래: "저장소 CSV 마지막 갱신 … · 월간 최신 … · 일간 최신 …"
- 대시보드 **데이터 불러오기** 버튼은 브라우저 캐시를 우회해 CSV를 다시 읽습니다. (Pages 반영까지 1~2분 걸릴 수 있음)

## 5-0. ↻ 버튼으로 최신 데이터 바로 받기 (서버 갱신)
제목 옆 ↻ 버튼은 **서버(GitHub Actions)에 갱신을 요청**합니다: 워크플로 실행 → 서버가 FRED에서 새 값을 받아 `data/*.csv` 갱신·커밋 → 사이트 반영을 확인 → 새 CSV를 다시 읽어 화면을 갱신합니다(보통 1~2분, 진행 상황은 버튼 옆에 표시).
새로 올라온 FRED 데이터가 없으면 “이미 최신”이라고 알려 줍니다.
- 브라우저는 여전히 FRED에 직접 접속하지 않습니다. 브라우저가 호출하는 외부 주소는 GitHub API(워크플로 실행 요청)뿐입니다.
- **처음 한 번 GitHub 토큰이 필요**합니다(버튼을 누르면 안내 창이 열립니다): fine-grained personal access token, *Repository access = 이 저장소만*,
  *Permissions → Actions: Read and write*. 토큰은 그 브라우저의 localStorage에만 저장됩니다(푸터의 ‘서버 갱신 설정’에서 삭제 가능). 공용 컴퓨터에서는 저장하지 마세요.
- 토큰이 없어도 ‘토큰 없이 CSV만 다시 읽기’(저장소의 현재 CSV를 캐시 없이 다시 읽음) 또는 Actions 페이지의 “Run workflow”로 갱신할 수 있습니다.
- 구현: `js/server-refresh.js`, 흐름 연결은 `app.js`의 `refreshFromServer()`.

## 5-1. 배포 직후 옛 화면이 보일 때 (캐시)
GitHub Pages는 파일을 브라우저에 약 10분간 캐시시킵니다. 이 대시보드는 자바스크립트가 여러 파일이라 일부만 옛 버전이 남으면 화면이 깨질 수 있어서,
`scripts/stamp_assets.py`가 js/css 내용의 해시를 `index.html`의 주소(`?v=해시`)와 import map에 넣습니다. 코드를 고치면 주소가 바뀌어 항상 짝이 맞는 새 파일을 받습니다.
Actions가 실행될 때마다 자동으로 갱신·커밋하므로(코드가 그대로면 변화 없음) 따로 할 일은 없습니다. 직접 배포한다면 `python credit-cycle/scripts/stamp_assets.py`를 한 번 실행하세요.
index.html 자체가 캐시돼 있으면 최대 10분 뒤 또는 강력 새로고침(Ctrl+Shift+R)으로 바뀝니다.

## 6. 로컬에서 보기
`index.html`을 더블클릭하면 fetch가 막힙니다. `credit-cycle` 폴더에서 `python -m http.server` 후 http://localhost:8000 으로 여세요.

## 7. 화면에 있는 기능들
- **화면 구성**: 맨 위 한 줄(제목 · **빌드 번호** · **FRED 데이터 날짜** · ↻ 새로 읽기 아이콘) → 탭 3개 → 차트 → 차트 옵션 → 차트 설명 → 현재 진단 카드. 첫 화면에 차트가 꽉 차도록 했고, 옵션은 모두 차트 아래에 있습니다.
  - 탭: **사이클 맵(VIX)**(첫 화면·기본) / **궤적 · 전망** / **시계열**. 선택한 탭은 주소(#t=…)에 저장됩니다. 탭 막대는 스크롤해도 위에 고정됩니다.
  - 빌드 표시 `빌드 #15 · d8532c0b`: 앞은 GitHub Actions 실행 번호(Actions 탭의 #번호와 같음), 뒤 8자리는 화면 코드(js/css) 버전입니다.
    `scripts/stamp_assets.py`가 워크플로 실행 때 자동으로 기록합니다. 사이트가 최신인지 확인할 때 이 번호를 보세요.
    바로 옆 `FRED 일간 2026-09-25 · 월간 2026-08`은 저장소 CSV의 마지막 관측일입니다(마우스를 올리면 저장소 마지막 갱신 시각).
  - 차트 설명(범례 안내, ‘전망은 어떻게 계산하나요?’)은 옵션 **아래**에 있어서, 옵션이 차트 바로 아래에 붙어 있습니다.
  - **차트 옵션**은 두 묶음입니다. ① **데이터 조건**(가로축 신용 지표 · 세로축 금리 구조 · 자료 빈도 · 기간) — 모든 탭에 똑같이 적용됩니다.
    ② **표시 옵션** — 지금 보는 탭에 해당하는 것만 나타납니다(사이클 맵: 로그 스케일·원 크기·연결선 등 / 궤적·전망: 국면 배경·최근 흐름 등 / 시계열: 경기침체 음영).
    켜고 끄는 옵션은 눌러서 켜는 칩(✓ 켜짐), 지금 쓸 수 없는 옵션은 흐리게 비활성화되고 마우스를 올리면 이유가 나옵니다.
- **신용 지표(가로축)**: V2(Baa−10Y), V4(Baa/Aaa), V6(하이일드 OAS), V7(BBB 회사채 스프레드)
  - V7: 최근 3년은 ICE BofA BBB US Corporate OAS(`BAMLC0A4CBBB`) 실제값, 그 이전은 같은 등급대인 Moody's Baa(= BBB 상당)의
    10년물 대비 스프레드를 겹치는 기간의 중앙값 차이만큼 보정해 이어 붙여 **1976년(월간)·1986년(일간)부터** 이어집니다
    (`transform.js`의 `spliceWithOffset()`, 화면 안내문에 보정값 표시). FRED는 ICE BofA 시리즈를 최신판뿐 아니라
    과거 판(ALFRED)에서도 최근 3년만 제공해서 실제 ICE BBB 과거값은 받을 수 없습니다 (`update_fred.py`의 과거 판 보충 시도 로그로 확인).
  - 저장소에 BBB 파일이 없으면 이 버전만 “데이터 없음” 안내가 뜨고 나머지는 그대로 동작합니다(`config.js`의 `OPTIONAL_KEYS`).
- **사이클 맵(VIX) 탭**: 가로 = 신용 지표, 세로 = 위 ‘세로축 · 금리 구조’에서 고른 값(10Y/2Y 비율 기본 / 10Y−2Y 금리차)
  - 원의 색 = 연도 그라데이션(viridis, 과거 보라 → 최근 노랑), **원의 크기 = 그 시점의 VIX**(크면 변동성↑·궤적이 빠르게 움직인 구간)
  - 가로·세로 **로그 스케일** 선택 (기본 둘 다 켜짐). 금리차처럼 음수가 있는 축은 로그가 불가능해 세로 로그 칩이 비활성화되고 선형으로 표시
  - 4분면 배경 + 순환 화살표(#1 위험 → #2 회복 → #3 확장 → #4 둔화), 날짜 라벨, 연결선, 원 크기 고정 선택
  - VIX는 1990년부터라 그 이전 시점은 작은 회색 테두리 원으로 표시
  - **▶ 흐름 재생**: 과거부터 현재까지 점이 시간순으로 찍혀 갑니다(약 10초). 화면 가운데에 지금 시점이 크게 표시되고, 축·색 범위는 전체 기준으로 고정됩니다. 다시 누르면 멈추고 전체 화면으로 돌아옵니다. 궤적 · 전망 탭에도 같은 버튼이 있습니다.
- **금리 구조(세로축)**: 10Y/2Y 비율(기본) 또는 10Y−2Y 금리차(%p). 역전선은 비율 1 / 금리차 0. 모든 탭이 같은 값을 씁니다.
  (기본이 비율인 이유: 첫 화면 사이클 맵이 로그 스케일이라 큰 변동폭이 잘 펴집니다. 선형 축인 궤적·전망 탭에서는 2Y≈0이던
  2011~2021년에 비율이 10 가까이 튀어 최근이 눌려 보이므로 금리차로 바꿔 보세요.)
- **자료 빈도**: 일 / 주 / 월 / 연. 주간은 일간 CSV를 브라우저에서 주평균(월~일, 금요일 마감 주)해서 만듭니다 —
  별도 파일이나 워크플로 변경이 필요 없습니다. 날짜는 그 주의 마지막 관측일이라 진행 중인 주도 표시됩니다.
- **기간**: 1/3/5/10/20년·전체 버튼 + 시작/종료일. **종료일을 과거로 옮기면 그 시점 기준의 진단·전망**을 볼 수 있습니다
  (전망 계산은 기준 시점 이전 정보만 사용).
- **현재 거시 환경 진단**: 현재 국면(4분면), 최근 3개월 흐름 해석(스프레드 확대/축소 × 커브 가팔라짐/평탄화),
  역전·역전 해소·스프레드 극단 신호, 신용스프레드 백분위, 장단기 금리차, 국채 2Y/10Y 수준과 변화, 침체 동반 비율.
- **앞으로의 경로(전망)** — 6개월/1년/2년 (연간 자료는 1/2/3년)
  - 현재와 위치·최근 6개월 흐름이 비슷한 과거 시점 10개를 찾고(서로 12개월 이상 간격), 그 이후 실제 경로를 현재 위치에 옮겨 붙입니다.
  - 궤적 위: 유사 시점 경로(가는 보라 선), 가중 평균 예상 경로(굵은 점선+화살표), 도달 범위 타원(약 68%)
  - 시계열 위: 예상 경로와 25–75% / 10–90% 부채꼴
  - 패널: 국면별 가능성, 스프레드 확대·커브 가팔라짐 가능성, 유사 시점 이후 침체 동반 비율(평소 비율과 비교), 유사 시점 목록(누르면 그때 실제 궤적 강조)
  - V6(하이일드)·V7(BBB)은 자체 이력이 짧아, 겹치는 기간의 로그-로그 회귀로 Baa−10Y 장기 이력을 하이일드 척도로 환산해 과거 유사 시점을 찾습니다
    (화면의 궤적은 실제 하이일드 값만 표시, 회귀 R²는 버전 안내문에 표시).
  - 통계적 예측 모형이 아니라 “역사가 비슷하게 흘러간다면”이라는 참고용 시나리오입니다.
- **궤적 도구**: ⌖ 현재 부근 확대(최근 3년+전망 범위), ▶ 흐름 재생(궤적이 시간순으로 그려지는 애니메이션)
- **표시 옵션**: 4단계 국면 배경(기본 켜짐, 경계 = 분석 이력 전체의 X 중앙값 + 역전선 — 참고용 휴리스틱), 최근 12개월 흐름 강조(기본 켜짐),
  흐름 화살표, 주요 시기 강조, 경기침체 음영(NBER), 궤적 색상(시간/이동 속도), 점 크기
- **링크 공유**: 선택한 버전·세로축·빈도·전망 기간·기간이 주소(#…)에 저장됩니다.

## 8. 향후 확장 위치
| 기능 | 위치 |
|---|---|
| 4단계 국면 판정 기준을 더 정교하게 | `overlays.js`의 `phaseShapesAndLabels()` (현재는 X 중앙값 + Y=1 4분면) |
| 주요 시기 목록 수정/추가 | `overlays.js`의 `EVENTS` 배열 |
| 특정 날짜 X/Y 표시 | `transform.js`의 `pointAt()` 사용 + `overlays.js`에 트레이스 추가 + `app.js`에 날짜 입력 |
| V2·V4·V6 동시 비교 | `app.js`의 `render()`에서 여러 버전의 `computePoints` 결과를 `overlays.traces`로 함께 전달 |
| 전망 방식 조정 (유사 시점 수, 모멘텀 기간·가중치, 간격, 전망 기간) | `config.js`의 `FORECAST` |
| 전망 알고리즘 교체/개선 | `forecast.js`의 `findAnalogs()` / `projectFromAnalogs()` / `summarizeProjection()` |
| 진단 문구·신호 규칙 | `forecast.js`의 `diagnose()`와 `FLOW_TEXT` |
| 짧은 지표를 장기 지표로 이어 붙이기 | `config.js` 버전에 `splice: {key, out, proxy, proxyLabel}` → `app.js`의 `ensureRows()`가 처리 |
| 사이클 맵 기본값(로그·원 크기·표시) | `config.js`의 `MAP_DEFAULTS`, 그리기는 `charts.js`의 `renderCycleMap()` |
| 새 빈도 추가 | `config.js`의 `FREQUENCIES`에 `{source, aggregate?, stepsPerMonth}` + 필요하면 `transform.js`에 집계 함수 |
| 새 버전(V8 등) 추가 | `config.js`의 `VERSIONS`에 객체 하나만 추가 (메뉴·그래프·카드 자동 반영) |
| 새 지표(시리즈) 추가 | `scripts/update_fred.py`의 `SERIES`에 `{fred_id, start}` 추가 → `config.js`의 `FREQUENCIES[*].files`에 매핑 |

표시 옵션 on/off는 `app.js`의 `state.features` / `state.colorMode`로 넘깁니다.

## 9. 테스트
`credit-cycle` 폴더에서 `node --test tests/unit.test.mjs` — 순수 함수(주평균, 날짜 이동, 유사 시점 탐색, 전망 경로, 프록시 환산, 오버레이)와 저장소의 실제 CSV로 모든 빈도·버전·세로축 조합의 전망 계산을 확인합니다.
