#!/usr/bin/env python3
"""
FRED → credit-cycle/data/*.csv 증분 업데이트 스크립트 (GitHub Actions 전용)

동작
  - CSV가 없거나 비어 있으면: 시리즈별 시작일부터 전체 다운로드
  - CSV가 있으면: 최근 LOOKBACK_DAYS(기본 120일)만 다시 받아 병합
  - 같은 날짜가 겹치면 새로 받은 값을 우선 → FRED 수정치(revision) 반영
  - FRED 결측값(".", 빈칸)은 빈 문자열로 저장 (브라우저에서 null 처리)
  - data/meta.json 에 시리즈별 기간·행 수·업데이트 시각 기록

데이터 소스
  - 환경변수 FRED_API_KEY 가 있으면 FRED 공식 API(api.stlouisfed.org) 사용
  - 없으면 fredgraph.csv (API 키 불필요) 사용
  ※ 이 스크립트는 GitHub Actions 러너에서만 실행됩니다. 브라우저는 FRED에 접속하지 않습니다.
"""
from __future__ import annotations

import csv
import io
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

DATA_DIR = Path(os.environ.get("DATA_DIR", Path(__file__).resolve().parent.parent / "data"))
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "120") or 120)
FULL_REFRESH = os.environ.get("FULL_REFRESH", "false").lower() == "true"
API_KEY = os.environ.get("FRED_API_KEY", "").strip()

MONTHLY_START = "1976-06-01"   # GS2 시작 시점
DAILY_START = "1986-01-02"     # DBAA/DAAA 시작 시점
HY_START = "1996-12-31"        # BAMLH0A0HYM2(하이일드 OAS) 시작 시점
BBB_START = "1996-12-31"       # BAMLC0A4CBBB(BBB 회사채 OAS) 시작 시점
VIX_START = "1990-01-02"       # VIXCLS(CBOE 변동성 지수) 시작 시점

# ICE BofA 시리즈는 2026-04부터 FRED 최신판에서 최근 3년치만 공개된다. 그 전에 공개됐던
# 과거 판(ALFRED vintage)에 남아 있는 이력으로 한 번 채워 보는 날짜들 (앞에서부터 시도).
BACKFILL_VINTAGES = ["2026-03-31", "2026-03-02", "2026-01-02", "2025-12-31"]
RECESSION_START = "1976-01-01"  # USREC — 우리 대시보드의 공통 시작보다 넉넉히 이르게

# key(파일명) → { fred_id, start, fq?, fam? }
#   fq/fam 은 fredgraph.csv·FRED API의 빈도 변환 옵션이다.
#   (fq="Monthly", fam="avg") 를 주면 일간 시리즈를 FRED가 직접 월평균해서 내려준다.
SERIES: dict[str, dict] = {
    # 월간 — Moody's 회사채 / 국채
    "BAA": {"fred_id": "BAA", "start": MONTHLY_START},
    "AAA": {"fred_id": "AAA", "start": MONTHLY_START},
    "GS10": {"fred_id": "GS10", "start": MONTHLY_START},
    "GS2": {"fred_id": "GS2", "start": MONTHLY_START},
    # 일간 — 위와 동일 시리즈의 일간 버전
    "DBAA": {"fred_id": "DBAA", "start": DAILY_START},
    "DAAA": {"fred_id": "DAAA", "start": DAILY_START},
    "DGS10": {"fred_id": "DGS10", "start": DAILY_START},
    "DGS2": {"fred_id": "DGS2", "start": DAILY_START},
    # 하이일드 스프레드 (ICE BofA US High Yield Index OAS). 원천은 일간뿐이라
    # 월간판은 FRED에 월평균 변환을 요청해서 만든다.
    # 주의: FRED가 2026-04부터 이 시리즈를 최근 3년치만 공개하도록 정책을 바꿔서,
    #       start를 이보다 이르게 줘도 실제로는 최근 3년치만 내려온다.
    "HY": {"fred_id": "BAMLH0A0HYM2", "start": HY_START},
    "HYM": {"fred_id": "BAMLH0A0HYM2", "start": HY_START, "fq": "Monthly", "fam": "avg"},
    # BBB 등급 회사채 스프레드 (ICE BofA BBB US Corporate Index OAS). 투자등급 중 가장 낮은 등급으로
    # 하이일드 바로 위에 있어 신용 경계 신호가 빠르다. HY와 같은 ICE BofA 시리즈라 FRED 공개 기간
    # 제한(최근 3년)이 똑같이 적용될 수 있다 — 짧으면 대시보드가 V2(Baa−10Y) 이력으로 보완한다.
    # backfill=True: 기존 파일이 시작일보다 1년 이상 늦게 시작하면 ALFRED 과거 판으로 앞부분을 채워 본다.
    "BBB": {"fred_id": "BAMLC0A4CBBB", "start": BBB_START, "backfill": True},
    "BBBM": {"fred_id": "BAMLC0A4CBBB", "start": BBB_START, "fq": "Monthly", "fam": "avg", "backfill": True},
    # CBOE 변동성 지수(VIX) — 사이클 맵에서 원 크기로 쓴다. 일간 + 월평균
    "VIX": {"fred_id": "VIXCLS", "start": VIX_START},
    "VIXM": {"fred_id": "VIXCLS", "start": VIX_START, "fq": "Monthly", "fam": "avg"},
    # NBER 경기침체 판정 (0/1, 월간) — 침체 음영 표시용
    "USREC": {"fred_id": "USREC", "start": RECESSION_START},
}

HEADERS = {"User-Agent": "credit-cycle-dashboard/1.0 (GitHub Actions)"}


# ---------------------------------------------------------------- 다운로드
def http_get(url: str, retries: int = 4) -> str:
    last: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=60) as res:
                return res.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            last = e
            if 400 <= e.code < 500 and e.code != 429:
                break  # 잘못된 요청/권한 오류는 재시도해도 소용없음
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last = e
        if attempt < retries:
            wait = 5 * attempt
            print(f"    재시도 {attempt}/{retries} ({last}) — {wait}초 대기", flush=True)
            time.sleep(wait)
    safe_url = url.replace(API_KEY, "***") if API_KEY else url
    raise RuntimeError(f"다운로드 실패: {safe_url} ({last})")


def parse_fred_csv(text: str, series_id: str) -> dict[str, str]:
    reader = csv.reader(io.StringIO(text))
    header = next(reader, None)
    if not header or len(header) < 2:
        raise RuntimeError(f"{series_id}: 예상하지 못한 CSV 형식: {text[:200]!r}")
    out: dict[str, str] = {}
    for row in reader:
        if len(row) < 2 or not row[0].strip():
            continue
        out[row[0].strip()] = normalize(row[1])
    return out


def fetch_fredgraph(meta: dict, start: str) -> dict[str, str]:
    params = {"id": meta["fred_id"], "cosd": start}
    if meta.get("fq"):
        params["fq"] = meta["fq"]
    if meta.get("fam"):
        params["fam"] = meta["fam"]
    q = urllib.parse.urlencode(params)
    return parse_fred_csv(http_get(f"https://fred.stlouisfed.org/graph/fredgraph.csv?{q}"), meta["fred_id"])


def fetch_api(meta: dict, start: str) -> dict[str, str]:
    params = {
        "series_id": meta["fred_id"],
        "api_key": API_KEY,
        "file_type": "json",
        "observation_start": start,
    }
    if meta.get("fq") == "Monthly":
        params["frequency"] = "m"
        params["aggregation_method"] = meta.get("fam", "avg")
    q = urllib.parse.urlencode(params)
    payload = json.loads(http_get(f"https://api.stlouisfed.org/fred/series/observations?{q}"))
    if "observations" not in payload:
        raise RuntimeError(f"{meta['fred_id']}: API 오류 응답: {str(payload)[:200]}")
    return {o["date"]: normalize(o["value"]) for o in payload["observations"]}


def fetch(meta: dict, start: str) -> dict[str, str]:
    return fetch_api(meta, start) if API_KEY else fetch_fredgraph(meta, start)


def fetch_vintage(meta: dict, start: str, vintage: str) -> dict[str, str]:
    """과거 판(vintage) 기준 관측치. API 키가 있으면 공식 API(realtime), 없으면 ALFRED CSV."""
    if API_KEY:
        params = {
            "series_id": meta["fred_id"], "api_key": API_KEY, "file_type": "json",
            "observation_start": start, "realtime_start": vintage, "realtime_end": vintage,
        }
        if meta.get("fq") == "Monthly":
            params["frequency"] = "m"
            params["aggregation_method"] = meta.get("fam", "avg")
        payload = json.loads(http_get("https://api.stlouisfed.org/fred/series/observations?"
                                      + urllib.parse.urlencode(params), retries=2))
        return {o["date"]: normalize(o["value"]) for o in payload.get("observations", [])}
    params = {"id": meta["fred_id"], "vintage_date": vintage, "cosd": start}
    if meta.get("fq"):
        params["fq"] = meta["fq"]
    if meta.get("fam"):
        params["fam"] = meta["fam"]
    q = urllib.parse.urlencode(params)
    return parse_fred_csv(http_get(f"https://alfred.stlouisfed.org/graph/alfredgraph.csv?{q}", retries=2), meta["fred_id"])


def backfill_history(series_id: str, meta: dict, existing: dict[str, str], fetcher=None) -> dict[str, str]:
    """기존 파일의 첫 날짜 이전 구간을 과거 판에서 가져온다. 겹치는 날짜는 건드리지 않는다(최신값 우선)."""
    fetcher = fetcher or fetch_vintage
    valid = sorted(d for d, v in existing.items() if v)
    first = valid[0] if valid else None
    start = meta["start"]
    if first and (date.fromisoformat(first) - date.fromisoformat(start)).days < 366:
        return {}
    for vintage in BACKFILL_VINTAGES:
        try:
            got = fetcher(meta, start, vintage)
        except Exception as e:  # noqa: BLE001 — 과거 판 조회 실패는 치명적이지 않다
            print(f"    과거 판 {vintage} 조회 실패: {e}", flush=True)
            continue
        older = {d: v for d, v in got.items() if v and (first is None or d < first) and d >= start}
        if older:
            ds = sorted(older)
            print(f"    과거 판 {vintage}에서 {len(older)}개 보충 ({ds[0]} ~ {ds[-1]})", flush=True)
            return older
        print(f"    과거 판 {vintage}: 더 이른 관측치 없음", flush=True)
    return {}


def normalize(value: str) -> str:
    v = (value or "").strip()
    if v in ("", "."):
        return ""
    try:
        float(v)
    except ValueError:
        return ""
    return v


# ---------------------------------------------------------------- CSV 입출력
def read_csv(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    out: dict[str, str] = {}
    with path.open(newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        next(reader, None)  # header
        for row in reader:
            if len(row) >= 2 and row[0].strip():
                out[row[0].strip()] = normalize(row[1])
    return out


def write_csv(path: Path, series_id: str, rows: dict[str, str]) -> None:
    tmp = path.with_suffix(".csv.tmp")
    with tmp.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["observation_date", series_id])
        for d in sorted(rows):
            w.writerow([d, rows[d]])
    tmp.replace(path)


def merge(existing: dict[str, str], fresh: dict[str, str], start: str) -> dict[str, str]:
    """기존 + 신규 병합. 날짜 중복 시 신규 우선. 시리즈 시작일 이전은 제거."""
    merged = dict(existing)
    merged.update(fresh)
    return {d: v for d, v in merged.items() if d >= start}


def summarize(rows: dict[str, str]) -> dict:
    valid = sorted(d for d, v in rows.items() if v)
    return {"rows": len(rows), "valid": len(valid),
            "first": valid[0] if valid else None,
            "last": valid[-1] if valid else None}


# ---------------------------------------------------------------- 메인
def update_series(series_id: str, meta: dict, fetcher=None, today: date | None = None) -> dict:
    fetcher = fetcher or fetch
    start = meta["start"]
    path = DATA_DIR / f"{series_id}.csv"
    existing = {} if FULL_REFRESH else read_csv(path)
    has_values = any(v for v in existing.values())

    if has_values:
        since = ((today or date.today()) - timedelta(days=LOOKBACK_DAYS)).isoformat()
        since = max(since, start)
        mode = f"증분 ({since}~)"
    else:
        since = start
        mode = f"전체 ({since}~)"

    print(f"[{series_id}] {mode} 다운로드", flush=True)
    fresh = {d: normalize(v) for d, v in fetcher(meta, since).items()}
    if not any(v for v in fresh.values()):
        if has_values:
            print("    경고: 새 데이터가 비어 있음 → 기존 파일 유지", flush=True)
            fresh = {}
        else:
            raise RuntimeError(f"{series_id}: 전체 다운로드 결과가 비어 있습니다.")

    merged = merge(existing, fresh, start)
    if meta.get("backfill"):
        older = backfill_history(series_id, meta, merged)
        if older:
            merged = merge(older, merged, start)  # 겹치면 최신 판 값 우선
    write_csv(path, series_id, merged)
    info = summarize(merged)
    print(f"    저장: 유효값 {info['valid']}개, {info['first']} ~ {info['last']}", flush=True)
    return info


def main() -> int:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    print(f"데이터 소스: {'FRED API' if API_KEY else 'fredgraph.csv'} / lookback {LOOKBACK_DAYS}일"
          f"{' / FULL REFRESH' if FULL_REFRESH else ''}")

    meta_series: dict[str, dict] = {}
    failures: list[str] = []
    for sid, meta in SERIES.items():
        try:
            meta_series[sid] = update_series(sid, meta)
        except Exception as e:  # noqa: BLE001
            print(f"[{sid}] 실패: {e}", file=sys.stderr, flush=True)
            failures.append(sid)
            meta_series[sid] = {**summarize(read_csv(DATA_DIR / f"{sid}.csv")), "error": str(e)}

    meta_path = DATA_DIR / "meta.json"
    old_meta = json.loads(meta_path.read_text("utf-8")) if meta_path.exists() else {}
    # 데이터 요약이 그대로면 meta.json 을 건드리지 않아 불필요한 커밋을 막는다.
    if old_meta.get("series") == meta_series:
        print("데이터 요약 변화 없음 (meta.json 유지)")
    else:
        meta = {
            "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source": "FRED API" if API_KEY else "fredgraph.csv",
            "series": meta_series,
        }
        meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", "utf-8")

    if failures:
        print(f"실패한 시리즈: {', '.join(failures)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
