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


def test_direct_connect_bypass_is_still_dropped_when_proxy_environment_is_cleared():
    # Bot commands can unset these variables; the kernel rules remain the boundary.
    env = {"HTTP_PROXY": "http://127.0.0.1", "ALL_PROXY": "http://127.0.0.1", "NO_PROXY": "localhost"}
    env.pop("ALL_PROXY")
    env.pop("NO_PROXY")
    assert "ALL_PROXY" not in env and "NO_PROXY" not in env
    rules = subprocess.run([sys.executable, str(ROOT / "deploy/egress-firewall.py"), "--print"], check=True, capture_output=True, text=True).stdout
    accepts = [line.strip() for line in rules.splitlines() if line.strip().endswith("accept")]
    port = json.loads((ROOT / "contracts/box-contract.json").read_text())["fixedPorts"]["egressProxy"]
    assert rules.split("chain output {", 1)[1].split("}", 1)[0].find("policy drop;") >= 0
    assert accepts == ["meta skuid @egress_proxy_uids accept", f"ip daddr 127.0.0.1 tcp dport {port} accept"]
    assert "ct state established,related accept" not in rules
    assert "set egress_proxy_uids { type uid; elements = { 0 }; }" in rules


def test_bot_peer_paths_are_denied_at_uid_and_loopback_boundary():
    rules = subprocess.run([sys.executable, str(ROOT / "deploy/egress-firewall.py"), "--print"], check=True, capture_output=True, text=True).stdout
    assert "meta skuid @bot_uids oifname \"lo\" drop" in rules
    assert "policy drop" in rules and "counter drop" in rules
    sys.path.insert(0, str(ROOT / "deploy"))
    import importlib.util
    spec = importlib.util.spec_from_file_location("egress_firewall", ROOT / "deploy/egress-firewall.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    configured = module.render([31001, 31002])
    assert "set bot_uids { type uid; elements = { 31001, 31002 }; }" in configured
    assert "meta skuid @bot_uids oifname \"lo\" drop" in configured


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
