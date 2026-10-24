"""Structured, injectable computer health checks."""
from __future__ import annotations

import os
import socket
import urllib.request
from pathlib import Path
from typing import Callable, Any
from box_contract import port_for


def _machine_id() -> str:
    return Path("/etc/machine-id").read_text().strip()


def _fd_ratio() -> float:
    soft, _ = __import__("resource").getrlimit(__import__("resource").RLIMIT_NOFILE)
    opened = len(list(Path("/proc/self/fd").iterdir()))
    return opened / max(1, soft)


def _chrome() -> bool:
    return any((Path("/proc") / item / "comm").read_text().strip() in {"chromium", "chrome"}
               for item in os.listdir("/proc") if item.isdigit() and (Path("/proc") / item / "comm").exists())


def _egress() -> bool:
    with urllib.request.urlopen("http://connectivitycheck.gstatic.com/generate_204", timeout=3) as response:
        return response.status == 204


def _clock_skew() -> float:
    request = urllib.request.Request("http://connectivitycheck.gstatic.com/generate_204", method="HEAD")
    with urllib.request.urlopen(request, timeout=3) as response:
        remote = response.headers.get("Date")
    if not remote:
        raise RuntimeError("remote time unavailable")
    from email.utils import parsedate_to_datetime
    import datetime
    remote_time = parsedate_to_datetime(remote).timestamp()
    return datetime.datetime.now(datetime.timezone.utc).timestamp() - remote_time


def _display() -> bool:
    return Path(f"/tmp/.X11-unix/X{os.environ.get('DISPLAY_NUM', '1')}").exists()


def _rfb() -> bool:
    display = int(os.environ.get("DISPLAY_NUM", "1"))
    override = os.environ.get("VNC_VIEW_PORT", "").strip()
    port = int(override) + display - 1 if override else port_for("vnc", display)
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1) as conn:
            return conn.recv(12).startswith(b"RFB 003.")
    except OSError:
        return False


def run_checks(*, machine_id: Callable[[], str] = _machine_id, chrome: Callable[[], bool] = _chrome,
               fd_ratio: Callable[[], float] = _fd_ratio, egress: Callable[[], bool] = _egress,
               clock_skew: Callable[[], float] = _clock_skew, display: Callable[[], bool] = _display,
               rfb: Callable[[], bool] = _rfb) -> dict[str, dict[str, Any]]:
    probes = {
        "machineId": (machine_id, lambda value: bool(value)),
        "chrome": (chrome, bool),
        "fdRatio": (fd_ratio, lambda value: 0 <= value < .9),
        "egress": (egress, bool),
        "clockSkew": (clock_skew, lambda value: abs(value) < 60),
        "display": (display, bool),
        "rfb": (rfb, bool),
    }
    result = {}
    for name, (probe, valid) in probes.items():
        try:
            value = probe()
            result[name] = {"ok": bool(valid(value)), "value": value}
        except Exception:
            result[name] = {"ok": False, "value": None}
    return result


def main() -> None:
    import json
    checks = run_checks()
    print(json.dumps({"ok": all(row["ok"] for row in checks.values()), "checks": checks}))


if __name__ == "__main__":
    main()
