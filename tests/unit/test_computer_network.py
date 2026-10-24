"""Computers stay off the network that holds Postgres and SeaweedFS."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
COMPOSE = (ROOT / "docker-compose.yml").read_text()
SCRIPT = (ROOT / "deploy/computer-isolation.sh").read_text()
MAKEFILE = (ROOT / "Makefile").read_text()


def service_blocks(text: str) -> dict[str, str]:
    blocks: dict[str, list[str]] = {}
    current: str | None = None
    in_services = False
    for line in text.splitlines():
        if line.startswith("services:"):
            in_services = True
            current = None
            continue
        if in_services and line and not line.startswith(" "):
            break
        if not in_services:
            continue
        if line.startswith("  ") and not line.startswith("    ") and line.rstrip().endswith(":"):
            current = line.strip()[:-1]
            blocks[current] = []
            continue
        if current is not None:
            blocks[current].append(line)
    return {name: "\n".join(lines) for name, lines in blocks.items()}


def test_user_computers_join_their_own_network():
    blocks = service_blocks(COMPOSE)
    assert "COMPUTE_NETWORK: teammates-computers" in blocks["api"]
    assert "ipv4_address: 172.30.28.10" in blocks["api"]
    assert "ipv4_address: 172.30.28.11" in blocks["agent"]
    for private in ("postgres", "object-store", "mock-openrouter", "web", "caddy"):
        assert "computers:" not in blocks[private], private
        assert "172.30.28." not in blocks[private], private
    assert "name: teammates-computers" in COMPOSE
    assert "subnet: 172.30.28.0/24" in COMPOSE
    computers = COMPOSE.split("name: teammates-computers", 1)[1].split("dockerctl:", 1)[0]
    assert "internal:" not in computers


def test_isolation_script_rejects_private_ranges_except_api_and_agent():
    policy = "\n".join(" ".join(rule) for rule in _rules().rules())
    assert "172.30.28.0/24" in policy
    assert "172.30.28.10/32" in policy
    assert "172.30.28.11/32" in policy
    assert "DOCKER-USER" in SCRIPT
    assert "REJECT --reject-with tcp-reset" in policy
    for private in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"):
        assert private in policy
    assert "bash deploy/computer-isolation.sh" in MAKEFILE


def test_api_reinstalls_isolation_before_a_computer_starts():
    blocks = service_blocks(COMPOSE)
    guard = blocks["isolation"]
    assert "network_mode: host" in guard
    assert "NET_ADMIN" in guard
    assert "mem_limit:" in guard
    assert "cpus:" in guard
    assert "ISOLATION_SOCKET" in blocks["api"]
    assert "ISOLATION_TOKEN" in blocks["api"]
    assert "/run/teammates" in blocks["api"]
    assert "ISOLATION_TOKEN" not in (ROOT / "services/computer/Dockerfile").read_text()
    provider = (ROOT / "src/Compute.Docker/DockerComputeProvider.cs").read_text()
    assert provider.count("await EnsureComputerIsolationAsync") >= 7
    program = (ROOT / "apps/api/Program.cs").read_text()
    assert "EnsureComputerIsolationAsync" in program
    assert "computer isolation alert" in program
    beta = (ROOT / "apps/api/Beta.cs").read_text()
    assert "computerIsolation" in beta
    guard_py = (ROOT / "deploy/isolation-guard/guard.py").read_text()
    assert "/ensure" in guard_py
    assert "computer-isolation.sh" in guard_py
    assert "rules_present" in guard_py


def _rules():
    import importlib.util
    spec = importlib.util.spec_from_file_location("computer_isolation_rules", ROOT / "deploy/isolation-guard/rules.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_dns_exceptions_are_only_resolver_port_53_before_private_drops():
    rules = _rules().rules("10.0.0.2,1.1.1.1")
    first_drop = next(i for i, rule in enumerate(rules) if "10.0.0.0/8" in rule)
    assert rules[3] == ["-s", "172.30.28.0/24", "-d", "172.30.28.10/32", "-p", "tcp", "-m", "tcp", "--dport", "8080", "-j", "RETURN"]
    exceptions = rules[4:first_drop]
    assert len(exceptions) == 6
    assert {r[r.index("-d") + 1] for r in exceptions} == {"10.0.0.2/32", "1.1.1.1/32", "127.0.0.11/32"}
    for rule in exceptions:
        assert rule == ["-s", "172.30.28.0/24", "-d", rule[3], "-p", rule[5], "-m", rule[5], "--dport", "53", "-j", "RETURN"]
        assert rule[5] in ("tcp", "udp")
    # Every private range has a catch-all drop, including ICMP and non-TCP/UDP.
    for private in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"):
        assert ["-s", "172.30.28.0/24", "-d", private, "-j", "DROP"] in rules
    assert rules[-1] == ["-j", "RETURN"]


def test_invalid_dns_fails_closed():
    import pytest
    for raw in ("", "1.1.1.1,", "10.0.0.0/8", "example.com", "::1", "1.1.1.1 -j ACCEPT"):
        with pytest.raises(ValueError):
            _rules().rules(raw)


def test_guard_detects_missing_reordered_or_broad_rules(monkeypatch):
    import importlib.util
    import sys
    policy = _rules()
    monkeypatch.setitem(sys.modules, "rules", policy)
    spec = importlib.util.spec_from_file_location("computer_isolation_guard", ROOT / "deploy/isolation-guard/guard.py")
    guard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guard)
    monkeypatch.setattr(guard, "iptables", lambda: "mock-iptables")
    monkeypatch.setenv("COMPUTER_DNS", "10.0.0.2")
    expected = policy.rules()
    actual = list(expected)
    def listing(argv, **kwargs):
        if argv[-1] == "DOCKER-USER":
            return "-A DOCKER-USER -j TEAMS-ISO\n"
        return "\n".join("-A TEAMS-ISO " + " ".join(r) for r in actual)
    monkeypatch.setattr(guard.subprocess, "check_output", listing)
    assert guard.rules_present()
    actual[3], actual[5] = actual[5], actual[3]
    assert not guard.rules_present()
    actual[:] = expected
    actual.insert(3, ["-s", "172.30.28.0/24", "-d", "10.0.0.0/8", "-j", "RETURN"])
    assert not guard.rules_present()
    actual[:] = expected
    monkeypatch.setenv("COMPUTER_DNS", "8.8.8.8")
    assert not guard.rules_present()
