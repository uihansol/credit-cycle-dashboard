#!/usr/bin/env python3
"""
index.html 이 불러오는 js/css 파일 주소에 내용 기반 버전(?v=해시)을 붙인다.

왜: GitHub Pages는 파일마다 약 10분간 브라우저 캐시를 허용한다. 이 대시보드는 ES 모듈이 여러 개라서,
배포 직후 일부만 옛 버전으로 남으면 새 HTML + 옛 코드가 섞여 화면이 깨질 수 있다. 파일 내용이 바뀌면
주소(?v=)도 바뀌게 해서 브라우저가 항상 짝이 맞는 새 파일을 받게 한다. 내용이 그대로면 해시도 그대로라
불필요한 커밋이 생기지 않는다.

  - <script type="module" src="./js/app.js?v=..."> 와 <link href="./css/style.css?v=...">
  - <script type="importmap"> 안의 "./js/xxx.js": "./js/xxx.js?v=..." (모듈끼리의 import도 같은 버전으로 연결)
GitHub Actions(update-fred-credit-cycle.yml)가 매번 실행하며, 로컬에서 직접 돌려도 된다.
"""
from __future__ import annotations

import hashlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "index.html"


def content_hash() -> str:
    h = hashlib.sha1()
    for path in sorted(list((ROOT / "js").glob("*.js")) + list((ROOT / "css").glob("*.css"))):
        h.update(path.relative_to(ROOT).as_posix().encode())
        h.update(path.read_bytes())
    return h.hexdigest()[:8]


def stamp(html: str, version: str) -> str:
    """src=/href= 속성 값과 import map 의 "값"(오른쪽)에만 ?v= 를 붙인다. import map 의 "키"(왼쪽)는 그대로 둔다."""
    ref = r'\./(?:js|css)/[\w.-]+\.(?:js|css)'
    # 1) src="./js/x.js[?v=..]" / href="./css/x.css[?v=..]"
    attr = re.compile(rf'((?:src|href)=")({ref})(?:\?v=\w+)?(")')
    html = attr.sub(lambda m: f"{m.group(1)}{m.group(2)}?v={version}{m.group(3)}", html)
    # 2) import map:  "키": "값[?v=..]"   →  키는 그대로, 값만 갱신
    imap = re.compile(rf'("{ref}")(\s*:\s*)"({ref})(?:\?v=\w+)?"')
    return imap.sub(lambda m: f'{m.group(1)}{m.group(2)}"{m.group(3)}?v={version}"', html)


def main() -> int:
    html = INDEX.read_text("utf-8")
    new = stamp(html, content_hash())
    if new != html:
        INDEX.write_text(new, "utf-8")
        print(f"index.html 자산 버전 갱신: ?v={content_hash()}")
    else:
        print("자산 버전 변화 없음")
    return 0


if __name__ == "__main__":
    sys.exit(main())
