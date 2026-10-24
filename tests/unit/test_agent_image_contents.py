"""The agent image must ship every local module worker.py/browser.py import (missed web_bot_auth.py once)."""
import re
from pathlib import Path

AGENT = Path(__file__).resolve().parents[2] / "services/agent"


def test_dockerfile_copies_every_local_module_imported():
    local = {p.stem for p in AGENT.glob("*.py")}
    copied = set()
    for line in (AGENT / "Dockerfile").read_text().splitlines():
        if line.startswith("COPY "):
            copied |= {Path(t).stem for t in line.split()[1:-1] if t.endswith(".py")}
    needed = set()
    for name in ("worker.py", "browser.py"):
        for m in re.finditer(r"^\s*(?:from|import)\s+([a-z_]+)", (AGENT / name).read_text(), re.M):
            if m.group(1) in local:
                needed.add(m.group(1))
    needed |= {"worker", "browser"}
    assert needed <= copied, sorted(needed - copied)
