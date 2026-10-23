"""Small health supervisor; production callers schedule tick every five seconds."""
from __future__ import annotations

import json
import os
import tempfile
import time
from pathlib import Path
from typing import Callable
from box_contract import port_for


class Supervisor:
    def __init__(self, status_path: Path, *, probe: Callable[[], bool], restart: Callable[[], None],
                 threshold: int = 2, clock: Callable[[], float] = time.time):
        if threshold < 1:
            raise ValueError("threshold must be positive")
        self.status_path = Path(status_path)
        self.probe, self.restart, self.threshold, self.clock = probe, restart, threshold, clock
        self.failures = 0

    def tick(self) -> bool:
        healthy = False
        try:
            healthy = bool(self.probe())
        except Exception:
            healthy = False
        self.failures = 0 if healthy else self.failures + 1
        restarted = False
        if not healthy and self.failures >= self.threshold:
            self.restart()
            self.failures = 0
            restarted = True
        self.status_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"healthy": healthy, "failures": self.failures, "restarted": restarted, "checkedAt": self.clock()}
        fd, name = tempfile.mkstemp(prefix="status-", dir=self.status_path.parent)
        try:
            with os.fdopen(fd, "w") as stream:
                json.dump(payload, stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(name, self.status_path)
        finally:
            try:
                os.unlink(name)
            except FileNotFoundError:
                pass
        return healthy


def run_forever(supervisor: Supervisor, interval: float = 5.0) -> None:
    while True:
        supervisor.tick()
        time.sleep(interval)


def _rfb_probe() -> bool:
    import socket
    display = int(os.environ.get("DISPLAY_NUM", "1"))
    override = os.environ.get("VNC_VIEW_PORT", "").strip()
    port = int(override) + display - 1 if override else port_for("vnc", display)
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1) as conn:
            return conn.recv(12) == b"RFB 003.008\n"
    except OSError:
        return False


def _restart_xvfb() -> None:
    import subprocess
    display = int(os.environ.get("DISPLAY_NUM", "1"))
    subprocess.run(["/command/s6-svc", "-r", f"/run/service/xvfb-{display}"],
                   check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    display = int(os.environ.get("DISPLAY_NUM", "1"))
    state = Path(os.environ.get("BOX_STATUS_PATH", "/run/desk/status.json"))
    run_forever(Supervisor(state, probe=_rfb_probe, restart=_restart_xvfb, threshold=2))
