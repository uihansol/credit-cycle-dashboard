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

SERIES = {
    # 월간
    "BAA": MONTHLY_START,
    "AAA": MONTHLY_START,
    "GS10": MONTHLY_START,
    "GS2": MONTHLY_START,
    # 일간
    "DBAA": DAILY_START,
    "DAAA": DAILY_START,
    "DGS10": DAILY_START,
    "DGS2": DAILY_START,
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


def fetch_fredgraph(series_id: str, start: str) -> dict[str, str]:
    q = urllib.parse.urlencode({"id": series_id, "cosd": start})
    return parse_fred_csv(http_get(f"https://fred.stlouisfed.org/graph/fredgraph.csv?{q}"), series_id)


def fetch_api(series_id: str, start: str) -> dict[str, str]:
    q = urllib.parse.urlencode({
        "series_id": series_id,
        "api_key": API_KEY,
        "file_type": "json",
        "observation_start": start,
    })
    payload = json.loads(http_get(f"https://api.stlouisfed.org/fred/series/observations?{q}"))
    if "observations" not in payload:
        raise RuntimeError(f"{series_id}: API 오류 응답: {str(payload)[:200]}")
    return {o["date"]: normalize(o["value"]) for o in payload["observations"]}


def fetch(series_id: str, start: str) -> dict[str, str]:
    return fetch_api(series_id, start) if API_KEY else fetch_fredgraph(series_id, start)


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
def update_series(series_id: str, start: str, fetcher=None, today: date | None = None) -> dict:
    fetcher = fetcher or fetch
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
    fresh = {d: normalize(v) for d, v in fetcher(series_id, since).items()}
    if not any(v for v in fresh.values()):
        if has_values:
            print("    경고: 새 데이터가 비어 있음 → 기존 파일 유지", flush=True)
            fresh = {}
        else:
            raise RuntimeError(f"{series_id}: 전체 다운로드 결과가 비어 있습니다.")

    merged = merge(existing, fresh, start)
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
    for sid, start in SERIES.items():
        try:
            meta_series[sid] = update_series(sid, start)
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
