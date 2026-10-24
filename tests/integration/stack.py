"""Names and URLs of the stack under test.

Every docker container, network and URL used by the integration suite derives
from COMPOSE_PROJECT so a run against an isolated test stack can never exec
into, restart, dump or query the default `teammates` stack.
"""
from __future__ import annotations

import os
import json
import re
import subprocess
import urllib.request
import urllib.error
import uuid

projects = {os.environ[name] for name in ("COMPOSE_PROJECT", "E2E_COMPOSE_PROJECT", "STACK", "COMPUTE_STACK") if os.environ.get(name)}
if len(projects) != 1:
    raise RuntimeError("Set STACK or COMPOSE_PROJECT to one consistent isolated stack name")
PROJECT = projects.pop()
if PROJECT == "teammates" or not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", PROJECT):
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
    name = os.environ.get(env, f"{PROJECT}-{service}-1")
    if name == "teammates" or name.startswith("teammates-"):
        raise RuntimeError("Live container overrides are forbidden in integration tests")
    return name


PG = container("postgres")
API_CONTAINER = container("api")
AGENT_CONTAINER = container("agent")
MOCK_CONTAINER = container("mock-openrouter")
OBJECT_STORE_CONTAINER = container("object-store")
COMPUTERS_NETWORK = os.environ.get("COMPUTERS_NETWORK", f"{PROJECT}-computers")
if COMPUTERS_NETWORK == "teammates-computers":
    raise RuntimeError("Live computer network overrides are forbidden in integration tests")
ISOLATION_SOCKET = os.environ.get("ISOLATION_SOCKET", f"/run/{PROJECT}/isolation.sock")
PROJECT_FILTER = f"label=com.docker.compose.project={PROJECT}"
COMPUTER_NETWORK_FILTER = f"network={COMPUTERS_NETWORK}"

COMPUTER_STACK_FILTER = f"label=teammates.stack={PROJECT}"


def computer_container(computer_id: str) -> str:
    """Resolve by computer id AND stack label before any lifecycle operation."""
    identifier = str(uuid.UUID(str(computer_id)))
    result = subprocess.run(["sudo", "docker", "ps", "-a", "--filter", COMPUTER_STACK_FILTER,
        "--filter", f"label=teammates.computer_id={identifier}", "--format", "{{.Names}}"],
        check=True, capture_output=True, text=True, timeout=30)
    names = result.stdout.split()
    if len(names) != 1:
        raise AssertionError(f"Expected one computer {identifier} in stack {PROJECT}; found {len(names)}")
    return names[0]


def worker_request(method: str, path: str, body=None):
    """Use an explicit worker credential, or the selected stack's agent identity.

    Never guess a dev token: isolated stacks may use a different worker token.
    The fallback keeps the credential inside the agent, never in command output.
    """
    if not path.startswith("/internal/"):
        raise ValueError("worker_request requires an internal path")
    if os.environ.get("WORKER_TOKEN"):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(API + path, data=data, method=method,
            headers={"Authorization": "Bearer " + os.environ["WORKER_TOKEN"], "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as exc:
            return exc.code, {"error": "worker request rejected"}
    script = """import json, os, sys, urllib.request, urllib.error
method, path, body = json.load(sys.stdin)
data = None if body is None else json.dumps(body).encode()
req = urllib.request.Request(os.environ['API_URL'].rstrip('/') + path, data=data, method=method,
    headers={'Authorization': 'Bearer ' + os.environ['WORKER_TOKEN'], 'Content-Type': 'application/json'})
try:
    with urllib.request.urlopen(req, timeout=30) as response:
        print(json.dumps([response.status, json.load(response)]))
except urllib.error.HTTPError as exc:
    print(json.dumps([exc.code, {'error': 'worker request rejected'}]))
"""
    result = subprocess.run(["sudo", "docker", "exec", "-i", AGENT_CONTAINER, "python3", "-c", script],
        input=json.dumps([method, path, body]), capture_output=True, text=True, check=True, timeout=40)
    return tuple(json.loads(result.stdout))
