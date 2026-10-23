"""A deleted computer container is rebuilt under the same id."""
from __future__ import annotations

import subprocess
import time

from test_acceptance import BASE, login, result_text, submit, wait_task
import os

# One compose project per live stack: STACK/STACK_SUBNET/ISOLATION_CHAIN default to the main `teammates` stack.
STACK = os.environ.get("STACK", "teammates")
SUBNET = os.environ.get("STACK_SUBNET", "172.30.28")
CHAIN = os.environ.get("ISOLATION_CHAIN", "TEAMS-ISO")


MARKER = "/workspace/notes/restore-marker.txt"
MARKER_BODY = b"kept-across-restore\n"
TERMINAL = "Terminal: write the word pong into /workspace/notes/ping.txt"


def _docker(*args: str) -> str:
    return subprocess.check_output(["sudo", "docker", *args], text=True).strip()


def _container(computer_id: str) -> str:
    return "tm" + computer_id.replace("-", "").lower()


def _wait_health(timeout: float = 90) -> None:
    deadline = time.time() + timeout
    last = ""
    while time.time() < deadline:
        try:
            probe = subprocess.check_output(["curl", "-fsS", BASE + "/health"], text=True, stderr=subprocess.DEVNULL)
        except subprocess.CalledProcessError as exc:
            last = str(exc)
            time.sleep(1)
            continue
        if probe:
            return
        time.sleep(1)
    raise AssertionError(f"api did not become healthy {last}")


def _state(name: str) -> str:
    try:
        return _docker("inspect", "-f", "{{.State.Status}}", name)
    except subprocess.CalledProcessError:
        return "missing"


def _bring_up(client, name: str, timeout: float = 120) -> None:
    """Other suites may have stopped or removed this computer. Ask the API for it and wait until it runs."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if _state(name) == "running":
            return
        status, body = client.call("POST", "/api/computer/restart", {})
        if status == 200 and _state(name) == "running":
            return
        time.sleep(1)
    raise AssertionError(f"computer {name} did not come up: {_state(name)}")


def _ensure_running(name: str) -> None:
    state = _state(name)
    if state == "paused":
        _docker("unpause", name)
    elif state not in {"running", "missing"}:
        _docker("start", name)


def test_deleted_container_recovers_on_the_next_tool_call():
    client = login()
    status, bots = client.call("GET", "/api/bots")
    assert status == 200 and bots, bots
    bot_id = bots[0]["id"]
    status, computer = client.call("GET", "/api/computer")
    assert status == 200, computer
    computer_id = computer.get("computerId")
    assert computer_id, computer
    name = _container(computer_id)
    _bring_up(client, name)
    try:
        _run(client, bot_id, computer_id, name)
    finally:
        _restore_if_missing(client, name)


def _restore_if_missing(client, name: str) -> None:
    try:
        listed = _docker("ps", "-a", "--filter", f"name=^{name}$", "--format", "{{.Names}}")
    except subprocess.CalledProcessError:
        return
    if name in listed.split():
        return
    try:
        _wait_health(30)
    except AssertionError:
        return
    client.call("POST", "/api/computer/recreate")


def _run(client, bot_id: str, computer_id: str, name: str) -> None:
    _ensure_running(name)
    status, uploaded = 0, None
    for _ in range(60):
        status, uploaded = client.call(
            "PUT",
            f"/api/bots/{bot_id}/files",
            raw=MARKER_BODY,
            headers={"x-path": MARKER, "Content-Type": "application/octet-stream"},
        )
        if status != 503:
            break
        time.sleep(1)  # the computer is still settling after an earlier suite
    assert status == 200, uploaded
    status, before = client.call("GET", f"/api/bots/{bot_id}/files/raw?path={MARKER}")
    assert status == 200 and MARKER_BODY.decode() in str(before), before

    _docker("rm", "-f", name)
    seen = set()
    task_id = submit(client, _conversation(client, bot_id), TERMINAL)
    deadline = time.time() + 180
    finished = None
    while time.time() < deadline:
        status, tasks = client.call("GET", f"/api/bots/{bot_id}/tasks")
        assert status == 200, tasks
        current = next(item for item in tasks if item["id"] == task_id)
        if current.get("waitingReason") == "computer_recovering" or current.get("status") == "waiting_resource":
            seen.add(current.get("waitingReason") or current.get("status"))
        if current["status"] in {"completed", "failed", "cancelled"}:
            finished = current
            break
        time.sleep(0.4)
    assert finished is not None, "tool call did not finish"
    assert finished["status"] == "completed", finished
    assert "Wrote pong" in result_text(finished)
    assert "computer_recovering" in seen, seen

    status, computer_after = client.call("GET", "/api/computer")
    assert status == 200, computer_after
    assert computer_after.get("computerId") == computer_id
    status, marker = client.call("GET", f"/api/bots/{bot_id}/files/raw?path={MARKER}")
    assert status == 200 and "kept-across-restore" in str(marker), marker
    running = _docker("ps", "--filter", f"name=^{name}$", "--format", "{{.Names}}")
    assert name in running.split()

    _docker("rm", "-f", name)
    _docker("restart", f"{STACK}-api-1")
    _wait_health()
    status, recreated = client.call("POST", "/api/computer/recreate")
    assert status == 200, recreated
    status, computer_reset = client.call("GET", "/api/computer")
    assert computer_reset.get("computerId") == computer_id, computer_reset
    again = wait_task(client, bot_id, submit(client, _conversation(client, bot_id), TERMINAL), timeout=180)
    assert again["status"] == "completed", again
    status, marker = client.call("GET", f"/api/bots/{bot_id}/files/raw?path={MARKER}")
    assert status == 200 and "kept-across-restore" in str(marker), marker


def _conversation(client, bot_id: str) -> str:
    status, workspace = client.call("GET", f"/api/bots/{bot_id}/workspace")
    assert status == 200, workspace
    return workspace["conversationId"]
