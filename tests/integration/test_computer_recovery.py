"""A deleted computer container is rebuilt under the same id."""
from __future__ import annotations

import subprocess
import time

import threading
from test_acceptance import BASE, auto_allow_browser_opens, login, result_text, submit, wait_task
from stack import API_CONTAINER, COMPUTER_STACK_FILTER, computer_container

MARKER = "/workspace/notes/restore-marker.txt"
MARKER_BODY = b"kept-across-restore\n"
TERMINAL = "Terminal: write the word pong into /workspace/notes/ping.txt"


def _docker(*args: str) -> str:
    return subprocess.check_output(["sudo", "docker", *args], text=True).strip()


def _container(computer_id: str) -> str:
    return computer_container(computer_id)


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


def test_deleted_container_recovers_on_the_next_tool_call(bot_factory):
    client = login()
    status, bots = client.call("GET", "/api/bots")
    assert status == 200, bots
    # Do not depend on bots left behind by earlier tests; create a disposable one if needed.
    bot_id = bots[0]["id"] if bots else bot_factory(client, "Recovery clerk")
    status, computer = client.call("GET", "/api/computer")
    assert status == 200, computer
    computer_id = computer.get("computerId")
    assert computer_id, computer
    name = _container(computer_id)
    _bring_up(client, name)
    # write_file always passes the action reviewer, so the task waits for Allow once.
    stop = threading.Event()
    auto_allow_browser_opens(bot_id, stop)
    try:
        _run(client, bot_id, computer_id, name)
    finally:
        stop.set()
        _restore_if_missing(client, name)


def _restore_if_missing(client, name: str) -> None:
    try:
        listed = _docker("ps", "-a", "--filter", f"name=^{name}$", "--filter", COMPUTER_STACK_FILTER, "--format", "{{.Names}}")
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
    running = _docker("ps", "--filter", f"name=^{name}$", "--filter", COMPUTER_STACK_FILTER, "--format", "{{.Names}}")
    assert name in running.split()

    _docker("rm", "-f", name)
    _docker("restart", API_CONTAINER)
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


def test_removed_stopped_computer_stays_stopped_until_asked(bot_factory):
    """Removing a stopped computer's container must not bring it back as running."""
    import uuid
    from test_acceptance import Client, _psql, worker_call
    from test_bot_messaging import _cleanup

    username = "stopped-missing-" + uuid.uuid4().hex[:12]
    password = "unit-stack-password-123"
    worker_call("POST", "/internal/test/users", {"username": username, "password": password})
    client = Client()
    assert client.call("POST", "/api/auth/login", {"username": username, "password": password})[0] == 200
    bot = bot_factory(client, "Stopped missing sentinel")
    _cleanup(client, bot)
    status, stopped = client.call("GET", "/api/computer")
    assert status == 200 and stopped["status"] == "stopped", stopped
    computer_id = stopped["computerId"]
    name = _container(computer_id)
    try:
        _docker("rm", "-f", name)
        # Reads and several housekeeping passes must not rebuild it.
        deadline = time.time() + 20
        while time.time() < deadline:
            status, computer = client.call("GET", "/api/computer")
            assert status == 200 and computer["status"] == "stopped", computer
            assert _state(name) == "missing", _state(name)
            time.sleep(1)
        assert _psql(f"SELECT status FROM user_computers WHERE computer_id='{computer_id}'") == "stopped"

        # An explicit request from the owner may rebuild it.
        _bring_up(client, name)
        assert _psql(f"SELECT status FROM user_computers WHERE computer_id='{computer_id}'") in {"running", "recovering"}
    finally:
        client.call("POST", "/api/computer/stop", {})
        subprocess.run(["sudo", "docker", "rm", "-f", name], capture_output=True)
