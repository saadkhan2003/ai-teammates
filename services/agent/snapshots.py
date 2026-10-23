"""Best-effort, throttled git checkpoint refs that never alter the worktree."""
from __future__ import annotations

import logging
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

log = logging.getLogger(__name__)


def maybe_snapshot(repo: str | Path, task_id: str, *, last_snapshot_at: str | None = None,
                   now: datetime | None = None, interval_seconds: int | None = None) -> dict | None:
    interval = interval_seconds or int(__import__("os").environ.get("SNAPSHOT_MIN_INTERVAL_SECONDS", "300"))
    now = now or datetime.now(timezone.utc)
    try:
        if last_snapshot_at:
            previous = datetime.fromisoformat(last_snapshot_at.replace("Z", "+00:00"))
            if (now - previous).total_seconds() < interval:
                return None
        path = Path(repo)
        if subprocess.run(["git", "-C", str(path), "rev-parse", "--git-dir"], capture_output=True,
                          text=True, timeout=5).returncode != 0:
            return None
        sha = subprocess.run(["git", "-C", str(path), "stash", "create"], capture_output=True,
                             text=True, timeout=15, check=True).stdout.strip()
        if not sha:
            return None
        short = task_id.replace("-", "")[:8]
        ref = f"refs/teammates/checkpoints/{short}"
        subprocess.run(["git", "-C", str(path), "update-ref", ref, sha], capture_output=True,
                       text=True, timeout=10, check=True)
        return {"snapshotRef": ref, "snapshotAt": now.isoformat().replace("+00:00", "Z")}
    except Exception as exc:
        log.warning("git snapshot skipped (%s)", type(exc).__name__)
        return None
