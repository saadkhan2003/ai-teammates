"""Offline checks for per-bot isolation and network-policy contracts."""
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def test_egress_firewall_only_allows_loopback_proxy_and_drops_all_else():
    result = subprocess.run([sys.executable, str(ROOT / "deploy/egress-firewall.py"), "--print"], check=True, capture_output=True, text=True)
    rules = result.stdout
    assert "policy drop" in rules
    port = json.loads((ROOT / "contracts/box-contract.json").read_text())["fixedPorts"]["egressProxy"]
    assert f"ip daddr 127.0.0.1 tcp dport {port} accept" in rules
    assert "set bot_uids { type uid; }" in rules
    assert "meta skuid @bot_uids" in rules
    assert "counter drop" in rules
    assert "udp dport 53 accept" not in rules


def test_proxy_ssrf_guard_blocks_sensitive_address_families_and_legacy_ipv4():
    sys.path.insert(0, str(ROOT / "services/computer/src"))
    from egress.ssrf import is_blocked_ip
    for address in ("169.254.169.254", "10.0.0.1", "100.64.0.1", "127.0.0.1", "fc00::1", "fe80::1", "::ffff:10.0.0.1", "0x0a000001", "012.0.0.1", "167772161"):
        assert is_blocked_ip(address), address


def test_browser_flags_prevent_local_dns_quic_and_nonproxied_webrtc():
    sys.path.insert(0, str(ROOT / "services/computer/src"))
    from browser_flags import chrome_egress_flags
    flags = chrome_egress_flags()
    assert any(x.startswith("--proxy-server=") for x in flags)
    assert any(x.startswith("--host-resolver-rules=") for x in flags)
    assert "--disable-quic" in flags
    assert "--force-webrtc-ip-handling-policy=disable_non_proxied_udp" in flags


def test_container_spec_has_hardening_settings():
    source = (ROOT / "src/Compute.Docker/DockerComputeProvider.cs").read_text()
    assert "CapDrop" in source and "no-new-privileges" in source and "PidsLimit" in source


def test_resource_override_documents_cgroup_limits_and_parses_yaml():
    snippet = ROOT / "deploy/compose.isolation-limits.yml"
    assert snippet.exists(), "compose override documenting I8 limits is missing"
    yaml = pytest.importorskip("yaml", reason="PyYAML unavailable for compose override parse")
    data = yaml.safe_load(snippet.read_text())
    limits = data["services"]["computer-template"]["deploy"]["resources"]["limits"]
    assert int(limits["pids"]) > 0 and limits["cpus"] and limits["memory"]
