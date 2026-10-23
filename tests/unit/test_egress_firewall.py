import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parents[2]
sys.path.insert(0, str(ROOT / "services/computer/src"))

from egress import firewall  # noqa: E402


def _print(*args):
    script = ROOT / "deploy/egress-firewall.py"
    return subprocess.run([sys.executable, str(script), "--print", *args], check=True, capture_output=True, text=True).stdout


def test_bot_uids_are_default_deny_with_proxy_as_only_exit():
    rules = _print("--bot-uid", "31001")
    assert "meta skuid != @bot_uids accept" in rules
    assert 'oifname "lo" ip daddr 127.0.0.1 tcp dport 8791 accept' in rules
    assert rules.rstrip().splitlines()[-3].strip() == "counter drop"
    assert "udp dport 53 accept" not in rules
    # Only these accept rules exist: non-bot uids, replies, the proxy, the bot's own dev ports.
    accepts = [line.strip() for line in rules.splitlines() if line.strip().endswith("accept")]
    assert accepts == [
        "meta skuid != @bot_uids accept",
        "ct state established,related accept",
        'oifname "lo" ip daddr 127.0.0.1 tcp dport 8791 accept',
        f'meta skuid 31001 oifname "lo" tcp dport {firewall.dev_port_range(31001)[0]}-{firewall.dev_port_range(31001)[1]} accept',
    ]


def test_each_bot_gets_its_own_loopback_port_range_and_no_overlap():
    first = firewall.dev_port_range(30000)
    second = firewall.dev_port_range(30001)
    assert first[1] < second[0]
    assert 1024 < first[0] and second[1] < 32768  # below the ephemeral range
    ranges = {firewall.dev_port_range(uid) for uid in range(30000, 30000 + firewall.DEV_SLOTS)}
    assert len(ranges) == firewall.DEV_SLOTS


def test_invalid_uids_are_rejected():
    for bad in (0, -1, 2**32, True):
        try:
            firewall.render([bad])
        except ValueError:
            continue
        raise AssertionError(bad)
