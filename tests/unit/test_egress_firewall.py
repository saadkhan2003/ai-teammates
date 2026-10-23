import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parents[2]


def test_rules_are_default_deny_allow_only_proxy_and_drop_everything_else():
    script = ROOT / "deploy/egress-firewall.py"
    result = subprocess.run([sys.executable, str(script), "--print"], check=True, capture_output=True, text=True)
    rules = result.stdout
    assert "policy drop" in rules
    assert "ip daddr 127.0.0.1 tcp dport 8791 accept" in rules
    assert "counter drop" in rules
    assert "udp dport 53 accept" not in rules
