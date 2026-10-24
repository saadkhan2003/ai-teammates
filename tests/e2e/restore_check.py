#!/usr/bin/env python3
"""Back up the running database, restore it into agent_restore, and check the AES-GCM key. Prints restore-ok."""
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def run(*args):
    return subprocess.run(args, cwd=ROOT, text=True, capture_output=True, timeout=150)


if not os.environ.get("STACK"):
    sys.exit("STACK is required so the check never touches the live stack")
backup = run("bash", "scripts/backup.sh")
if backup.returncode != 0:
    sys.exit("backup failed: " + backup.stderr[-300:])
dump = sorted((ROOT / "backups").glob("agent-*.dump"), key=lambda p: p.stat().st_mtime)[-1]
restore = run("bash", "scripts/restore-verify.sh", str(dump))
if restore.returncode != 0 or "real key decrypted" not in restore.stdout:
    sys.exit("restore failed: " + restore.stderr[-300:])
print("restore-ok")
