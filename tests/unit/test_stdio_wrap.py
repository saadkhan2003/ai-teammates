"""The stdio wrapper is what the computer container executes. It is not started on the host by the API."""
import json
import subprocess
import sys
from pathlib import Path

WRAP = Path(__file__).resolve().parents[2] / "apps" / "api" / "stdio_wrap.py"


def test_wrapper_runs_the_child_and_stops_a_hang():
    rpc = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call"})
    command = json.dumps(["python3", "-c", "import sys; sys.stdout.write(sys.stdin.read())"])
    ran = subprocess.run([sys.executable, str(WRAP), command, rpc, "2"], text=True, capture_output=True, timeout=10)
    assert ran.returncode == 0, ran.stderr
    assert json.loads(ran.stdout)["method"] == "tools/call"
    hang = json.dumps(["python3", "-c", "import time; time.sleep(30)"])
    hung = subprocess.run([sys.executable, str(WRAP), hang, "{}", "1"], text=True, capture_output=True, timeout=8)
    assert hung.returncode != 0
