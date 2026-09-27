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
    │   ├── config.js        # 시리즈·빈도·V2/V4 정의  ← 새 버전/지표 추가
    │   ├── data-loader.js   # ./data/*.csv 읽기·파싱·오류 수집
    │   ├── transform.js     # 정렬·결측 제거·연평균·기간 필터·X/Y 계산 (순수 함수)
    │   ├── charts.js        # Plotly 그래프 3종
    │   ├── overlays.js      # 궤적 위 덧그리기 (4단계 국면·주요 시기·현재점) ← 향후 확장
    │   └── app.js           # 상태·컨트롤 연결
    ├── scripts/update_fred.py   # Actions가 실행하는 다운로드·병합 스크립트
    └── data/                    # Actions가 채움 (BAA, AAA, GS10, GS2, DBAA, DAAA, DGS10, DGS2 .csv + meta.json)
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
첫 실행은 전체 기간(월간 1976-06-01~, 일간 1986-01-02~)을 받고 `credit-cycle/data/`에 커밋합니다 (1~2분).
이후에는 평일 UTC 02:15(한국 11:15)마다 최근 120일만 다시 받아 병합합니다. 같은 날짜는 새 값이 우선이라 FRED 수정치도 반영됩니다.

수동 실행 옵션: `full_refresh`(전체 재다운로드), `lookback_days`(증분 기간).

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

## 6. 로컬에서 보기
`index.html`을 더블클릭하면 fetch가 막힙니다. `credit-cycle` 폴더에서 `python -m http.server` 후 http://localhost:8000 으로 여세요.

## 7. 향후 확장 위치
| 기능 | 위치 |
|---|---|
| 4단계 국면 영역(#1 위험 ~ #4 둔화) | `overlays.js`의 `PHASES` + `buildOverlays()` 확장 1, 판정 로직은 `transform.js`의 `classifyPhase` |
| 2000/2008/2020/2022 주요 시기 | `overlays.js`의 `EVENTS` (주석 해제) + 확장 2 |
| 현재 위치 큰 점 | `overlays.js` 확장 3 |
| 특정 날짜 X/Y 표시 | `transform.js`에 `pointAt()` + `overlays.js` 확장 4 + `app.js`에 날짜 입력 |
| 1년/3년/5년/10년/전체 버튼 | `app.js`에서 `state.start`만 바꾸고 `applyDateRules(); render();` 호출 |
| V2·V4 동시 비교 | `app.js`의 `render()`에서 두 버전 `computePoints` 결과를 `buildOverlays`의 `traces`로 전달 |
| 비슷한 과거 위치 탐색 | `transform.js`의 `findSimilarPeriods` + 확장 5 |
| 새 버전(V5 등) | `config.js`의 `VERSIONS`에 객체 하나 추가 (메뉴·그래프·카드 자동 반영) |
기능 on/off는 `app.js`의 `state.features`로 넘깁니다.
