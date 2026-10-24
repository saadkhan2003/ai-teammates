"""Names and URLs of the stack under test.

Every docker container, network and URL used by the integration suite derives
from COMPOSE_PROJECT so a run against an isolated test stack can never exec
into, restart, dump or query the default `teammates` stack.
"""
from __future__ import annotations

import os

projects = {os.environ[name] for name in ("COMPOSE_PROJECT", "STACK", "COMPUTE_STACK") if os.environ.get(name)}
if len(projects) != 1:
    raise RuntimeError("Set STACK or COMPOSE_PROJECT to one consistent isolated stack name")
PROJECT = projects.pop()
if PROJECT == "teammates":
    raise RuntimeError("Integration tests require an isolated stack")
if not os.environ.get("BASE_URL") or not os.environ.get("API_URL"):
    raise RuntimeError("BASE_URL and API_URL are required for integration tests")
BASE = os.environ["BASE_URL"].rstrip("/")
API = os.environ["API_URL"].rstrip("/")
SUBNET = os.environ.get("STACK_SUBNET", "")
CHAIN = os.environ.get("ISOLATION_CHAIN", "")


def container(service: str) -> str:
    env = service.upper().replace("-", "_") + "_CONTAINER"
    if service == "postgres":
        env = "PG_CONTAINER"
    return os.environ.get(env, f"{PROJECT}-{service}-1")


PG = container("postgres")
API_CONTAINER = container("api")
AGENT_CONTAINER = container("agent")
MOCK_CONTAINER = container("mock-openrouter")
OBJECT_STORE_CONTAINER = container("object-store")
COMPUTERS_NETWORK = os.environ.get("COMPUTERS_NETWORK", f"{PROJECT}-computers")
PROJECT_FILTER = f"label=com.docker.compose.project={PROJECT}"
COMPUTER_NETWORK_FILTER = f"network={COMPUTERS_NETWORK}"
