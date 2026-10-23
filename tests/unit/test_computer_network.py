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
    assert "172.30.28.0/24" in SCRIPT
    assert "172.30.28.10/32" in SCRIPT
    assert "172.30.28.11/32" in SCRIPT
    assert "DOCKER-USER" in SCRIPT
    assert "REJECT --reject-with tcp-reset" in SCRIPT
    assert "10.0.0.0/8" in SCRIPT
    assert "172.16.0.0/12" in SCRIPT
    assert "192.168.0.0/16" in SCRIPT
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
