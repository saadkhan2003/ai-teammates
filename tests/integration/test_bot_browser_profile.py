"""Deleting the bot whose id keys the shared desktop must not leave its Chrome
profile behind, and the desktop's Chrome must move to a fresh scratch profile."""
from __future__ import annotations

import re
import subprocess
import time
import uuid

from stack import computer_container


def _exec(name: str, script: str) -> str:
    return subprocess.run(["sudo", "docker", "exec", name, "sh", "-c", script],
                          capture_output=True, text=True, timeout=60).stdout.strip()


def _profiles(name: str) -> dict[str, str]:
    """display service -> its --user-data-dir."""
    found = {}
    for line in _exec(name, "grep -H -o -- '--user-data-dir=[^ ]*' /run/service/chrome-*/run 2>/dev/null").splitlines():
        service, _, flag = line.partition(":")
        found[service.split("/")[3]] = flag.split("=", 1)[1]
    return found


def test_deleted_desk_bot_chrome_profile_is_wiped(bot_factory):
    from test_acceptance import Client, worker_call
    from test_bot_messaging import _cleanup

    username = "browser-profile-" + uuid.uuid4().hex[:12]
    password = "unit-stack-password-123"
    worker_call("POST", "/internal/test/users", {"username": username, "password": password})
    client = Client()
    assert client.call("POST", "/api/auth/login", {"username": username, "password": password})[0] == 200
    first = bot_factory(client, "Desk owner bot")
    second = bot_factory(client, "Second bot")
    status, computer = client.call("GET", "/api/computer")
    assert status == 200, computer
    name = computer_container(computer["computerId"])
    try:
        deadline = time.time() + 120
        while time.time() < deadline and not _profiles(name):
            time.sleep(1)
        before = _profiles(name)
        assert before, "no Chrome service on the shared desktop"
        keyed = {service: path for service, path in before.items() if path.endswith(first.replace("-", ""))}
        assert keyed, before
        for path in keyed.values():
            _exec(name, f"mkdir -p {path}/Default && echo secret > {path}/Default/teammates-leak-probe")
        assert client.call("DELETE", f"/api/bots/{first}")[0] == 204
        after = _profiles(name)
        for service, path in keyed.items():
            assert _exec(name, f"test -e {path} && echo present || echo gone") == "gone"
            assert after[service] != path and re.fullmatch(r"/data/profiles/[0-9a-f]{32}", after[service]), after
        deadline = time.time() + 60
        while time.time() < deadline and not all(
                after[s] in _exec(name, "ps -eo args | grep -- --user-data-dir= | grep -v grep") for s in keyed):
            time.sleep(1)
        running = _exec(name, "ps -eo args | grep -- --user-data-dir= | grep -v grep")
        for service, path in keyed.items():
            assert after[service] in running and f"--user-data-dir={path} " not in running
        assert _exec(name, "grep -rl teammates-leak-probe /data/profiles 2>/dev/null; find /data/profiles -name teammates-leak-probe") == ""
    finally:
        _cleanup(client, second)
