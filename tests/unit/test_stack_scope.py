"""The two test-plumbing conventions must resolve the same isolated stack."""
from pathlib import Path
import runpy
import pytest

ROOT = Path(__file__).resolve().parents[2]


def scope(monkeypatch, **values):
    for name in ("STACK", "COMPOSE_PROJECT", "COMPUTE_STACK", "E2E_COMPOSE_PROJECT", "BASE_URL", "API_URL", "PG_CONTAINER", "COMPUTERS_NETWORK", "ISOLATION_SOCKET", "ISOLATION_CHAIN", "STACK_SUBNET"):
        monkeypatch.delenv(name, raising=False)
    for name, value in values.items():
        monkeypatch.setenv(name, value)
    return runpy.run_path(str(ROOT / "tests/integration/stack.py"))


@pytest.mark.parametrize("alias", ["STACK", "COMPOSE_PROJECT", "COMPUTE_STACK", "E2E_COMPOSE_PROJECT"])
def test_stack_aliases_scope_every_service(monkeypatch, alias):
    result = scope(monkeypatch, **{alias: "v04m", "BASE_URL": "http://localhost:28080", "API_URL": "http://localhost:28081"})
    assert result["PG"] == "v04m-postgres-1"
    assert result["API_CONTAINER"] == "v04m-api-1"
    assert result["AGENT_CONTAINER"] == "v04m-agent-1"
    assert result["MOCK_CONTAINER"] == "v04m-mock-openrouter-1"
    assert result["COMPUTER_NETWORK_FILTER"] == "network=v04m-computers"
    assert result["PROJECT_FILTER"] == "label=com.docker.compose.project=v04m"


@pytest.mark.parametrize("values", [{}, {"STACK": "teammates"}, {"STACK": "v04m", "COMPOSE_PROJECT": "other"}, {"STACK": "v04m"}])
def test_ambiguous_or_live_stack_is_rejected_before_docker(monkeypatch, values):
    with pytest.raises(RuntimeError):
        scope(monkeypatch, **values)


def test_stack_aliases_accept_consistent_project_and_explicit_pg(monkeypatch):
    result = scope(monkeypatch, STACK="v04m", COMPOSE_PROJECT="v04m", COMPUTE_STACK="v04m", BASE_URL="http://localhost:28080", API_URL="http://localhost:28081", PG_CONTAINER="v04m-db")
    assert result["PG"] == "v04m-db"


@pytest.mark.parametrize("override", [{"PG_CONTAINER": "teammates-postgres-1"}, {"COMPUTERS_NETWORK": "teammates-computers"}])
def test_live_resource_overrides_are_rejected(monkeypatch, override):
    with pytest.raises(RuntimeError):
        scope(monkeypatch, STACK="v04m", BASE_URL="http://localhost:58080", API_URL="http://localhost:58081", **override)


def test_isolation_socket_uses_selected_project(monkeypatch):
    result = scope(monkeypatch, STACK="v04m", BASE_URL="http://localhost:58080", API_URL="http://localhost:58081")
    assert result["ISOLATION_SOCKET"] == "/run/v04m/isolation.sock"
