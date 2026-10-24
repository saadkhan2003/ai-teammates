"""CLI used by start-window and stop-window inside the computer container."""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from urllib.parse import quote

from box_contract import MAX_WINDOWS


def main(action: str, args: list[str]) -> int:
    if len(args) != 2 or not args[0] or not args[1].isascii() or not args[1].isdecimal():
        return 2
    window = int(args[1])
    if not 1 <= window <= MAX_WINDOWS:
        return 2
    token = os.environ.get("COMPUTER_TOKEN", "")
    computer = args[0]
    if not token or len(computer) > 128:
        return 2
    request = urllib.request.Request(
        f"http://127.0.0.1:7700/windows/{quote(computer, safe='')}/{window}",
        data=b"{}" if action == "start" else None,
        method="POST" if action == "start" else "DELETE",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            json.load(response)
        return 0
    except (OSError, urllib.error.URLError):
        return 1


if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in {"start", "stop"}:
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1], sys.argv[2:]))
