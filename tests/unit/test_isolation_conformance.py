"""Offline checks for per-bot isolation and network-policy contracts."""
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def test_egress_firewall_only_allows_loopback_proxy_and_own_dev_ports_for_bots():
    result = subprocess.run([sys.executable, str(ROOT / "deploy/egress-firewall.py"), "--print", "--bot-uid", "31001"], check=True, capture_output=True, text=True)
    rules = result.stdout
    port = json.loads((ROOT / "contracts/box-contract.json").read_text())["fixedPorts"]["egressProxy"]
    assert f'oifname "lo" ip daddr 127.0.0.1 tcp dport {port} accept' in rules
    assert "set bot_uids { type uid; elements = { 31001 }; }" in rules
    assert "meta skuid != @bot_uids accept" in rules
    assert "counter drop" in rules
    assert "udp dport 53 accept" not in rules


def test_direct_connect_bypass_is_still_dropped_when_proxy_environment_is_cleared():
    # Bot commands can unset proxy variables; the kernel rules remain the boundary.
    rules = subprocess.run([sys.executable, str(ROOT / "deploy/egress-firewall.py"), "--print", "--bot-uid", "31001"], check=True, capture_output=True, text=True).stdout
    accepts = [line.strip() for line in rules.splitlines() if line.strip().endswith("accept")]
    port = json.loads((ROOT / "contracts/box-contract.json").read_text())["fixedPorts"]["egressProxy"]
    assert not any("daddr" in line and "127.0.0.1" not in line for line in accepts)
    assert sum(1 for line in accepts if "dport" in line and line.startswith("oifname")) == 1
    assert f'oifname "lo" ip daddr 127.0.0.1 tcp dport {port} accept' in accepts
    assert rules.index("counter drop") > max(rules.index(line) for line in accepts)


def test_bot_peer_paths_are_denied_by_per_bot_loopback_ranges():
    sys.path.insert(0, str(ROOT / "services/computer/src"))
    from egress import firewall
    configured = firewall.render([31001, 31002])
    assert "set bot_uids { type uid; elements = { 31001, 31002 }; }" in configured
    own_a, own_b = firewall.dev_port_range(31001), firewall.dev_port_range(31002)
    assert f"meta skuid 31001 oifname \"lo\" tcp dport {own_a[0]}-{own_a[1]} accept" in configured
    assert f"meta skuid 31002 oifname \"lo\" tcp dport {own_b[0]}-{own_b[1]} accept" in configured
    assert own_a[1] < own_b[0] or own_b[1] < own_a[0]
    assert "meta skuid @bot_uids oifname" not in configured


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
