"""Names and URLs of the stack under test.

Every docker container, network and URL used by the integration suite derives
from COMPOSE_PROJECT so a run against an isolated test stack can never exec
into, restart, dump or query the default `teammates` stack.
"""
from __future__ import annotations

import os

PROJECT = os.environ.get("COMPOSE_PROJECT", "teammates")
BASE = os.environ.get("BASE_URL", "http://127.0.0.1:18080").rstrip("/")
API = os.environ.get("API_URL", "http://127.0.0.1:18081").rstrip("/")

if PROJECT == "teammates" and not (BASE.endswith(":18080") and API.endswith(":18081")):
    raise RuntimeError(
        f"BASE_URL/API_URL ({BASE}, {API}) are not the default stack but COMPOSE_PROJECT is unset; "
        "set COMPOSE_PROJECT to the compose project under test"
    )


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
