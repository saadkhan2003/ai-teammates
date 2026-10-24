"""Two bots on one computer cannot read each other's workspace. Deleting a bot removes its files."""
from __future__ import annotations

import json
import subprocess
import time

from test_acceptance import login
from stack import computer_container


def test_bots_have_separate_workspaces_and_delete_wipes():
    client = login()
    status, first = client.call("POST", "/api/bots", {"name": "Workspace A", "role": "a"})
    assert status == 200, first
    status, second = client.call("POST", "/api/bots", {"name": "Workspace B", "role": "b"})
    assert status == 200, second
    left = first["id"]
    right = second["id"]
    secret = b"bot-a-only-secret\n"
    status, uploaded = client.call(
        "PUT",
        f"/api/bots/{left}/files",
        raw=secret,
        headers={"x-path": "/workspace/notes/private.txt", "Content-Type": "application/octet-stream"},
    )
    assert status == 200, uploaded
    status, own = client.call("GET", f"/api/bots/{left}/files/raw?path=/workspace/notes/private.txt")
    assert status == 200 and secret.decode() in str(own), own
    status, other = client.call("GET", f"/api/bots/{right}/files/raw?path=/workspace/notes/private.txt")
    assert status == 404, other
    status, listing = client.call("GET", f"/api/bots/{right}/files?path=/workspace/notes")
    assert status == 200, listing
    assert "private.txt" not in json_text(listing)
    status, escaped = client.call(
        "GET",
        f"/api/bots/{right}/files/raw?path=/workspace/../bots/{left.replace('-', '')}/notes/private.txt",
    )
    assert status != 200 or secret.decode() not in str(escaped), escaped

    status, computer = client.call("GET", "/api/computer")
    assert status == 200, computer
    name = computer_container(computer["computerId"])
    host_path = f"/data/workspace/bots/{right.replace('-', '')}/notes/own.txt"
    client.call(
        "PUT",
        f"/api/bots/{right}/files",
        raw=b"bot-b\n",
        headers={"x-path": "/workspace/notes/own.txt", "Content-Type": "application/octet-stream"},
    )
    before = subprocess.run(["sudo", "docker", "exec", name, "cat", host_path], capture_output=True, text=True)
    assert before.returncode == 0 and "bot-b" in before.stdout, before.stderr

    # Bots on one computer share its single desktop, keyed by the computer id and fenced by an epoch.
    desktop = str(computer["computerId"])
    ensure_status, ensured = computer_api(
        name, "POST", "/desktops", json.dumps({"botId": desktop, "display": 1, "chrome": False})
    )
    assert ensure_status == "200", ensured
    # Readiness and effect authority are separate. Reconcile through the API's
    # durable lease, then use the epoch actually installed on the computer.
    assert json.loads(ensured).get("ready"), ensured
    status, continued = client.call("POST", f"/api/computers/{left}/continue", {})
    assert status == 200, continued
    lease_status, lease = computer_api(name, "POST", f"/desktops/{desktop}/lease",
        json.dumps({"actorId": "workspace-isolation-test", "action": "state"}))
    assert lease_status == "200" and json.loads(lease)["role"] == "agent", lease
    epoch = json.loads(lease)["epoch"]
    other_file = f"/desktops/{left}/files/raw?path=/workspace/notes/own.txt"
    status_line, body = computer_api(name, "GET", other_file)
    assert status_line != "200" or "bot-b" not in body, body
    shell_body = json.dumps({
        "command": f"id -u; cat /data/workspace/bots/{right.replace('-', '')}/notes/own.txt",
        "actor_id": "agent:workspace-isolation-test",
        "epoch": epoch,
        # The desktop is keyed by the owner's first bot, which an earlier test may have deleted
        # (its workspace is tombstoned); the API always names the calling bot, here bot A.
        "workspace_bot_id": left,
    })
    shell_status, shell = computer_api(name, "POST", f"/desktops/{desktop}/shell", shell_body)
    assert shell_status == "200", shell
    parsed = json.loads(shell)
    assert "bot-b" not in parsed.get("stdout", ""), parsed
    assert parsed.get("exitCode") != 0, parsed
    uid_line = str(parsed.get("stdout") or "").splitlines()[0].strip()
    assert uid_line.isdigit() and uid_line != "0", parsed
    desk = subprocess.run(
        ["sudo", "docker", "exec", "--user", "desk", name, "cat", f"/data/workspace/bots/{left.replace('-', '')}/notes/private.txt"],
        capture_output=True,
        text=True,
    )
    assert desk.returncode != 0 and secret.decode() not in desk.stdout, desk.stdout
    home_mode = subprocess.run(
        ["sudo", "docker", "exec", name, "stat", "-c", "%a", f"/data/home/{left.replace('-', '')}"],
        capture_output=True,
        text=True,
    )
    assert home_mode.stdout.strip() == "700", home_mode.stderr
    home_read = subprocess.run(
        ["sudo", "docker", "exec", "--user", "desk", name, "ls", f"/data/home/{left.replace('-', '')}"],
        capture_output=True,
        text=True,
    )
    assert home_read.returncode != 0, home_read.stdout
    procs = subprocess.run(["sudo", "docker", "exec", name, "ps", "-eo", "uid=,cmd="], capture_output=True, text=True)
    openbox = next((line for line in procs.stdout.splitlines() if "xfwm4" in line and "grep" not in line), "")
    assert openbox, procs.stdout
    wm_uid = openbox.split()[0]
    owner = subprocess.run(
        ["sudo", "docker", "exec", name, "stat", "-c", "%u", f"/data/workspace/bots/{left.replace('-', '')}"],
        capture_output=True,
        text=True,
    )
    # The shared desktop belongs to the account's first bot. It must not be desk, and it must own its own tree.
    desktop_id = subprocess.run(["sudo", "docker", "exec", name, "printenv", "COMPUTER_ID"], capture_output=True, text=True)
    desktop_safe = desktop_id.stdout.strip().replace("-", "")
    desktop_owner = subprocess.run(
        ["sudo", "docker", "exec", name, "stat", "-c", "%u", f"/data/workspace/bots/{desktop_safe}"],
        capture_output=True,
        text=True,
    )
    desk_uid = subprocess.run(["sudo", "docker", "exec", name, "id", "-u", "desk"], capture_output=True, text=True).stdout.strip()
    assert wm_uid not in ("0", desk_uid), (openbox, desk_uid)
    if desktop_owner.returncode == 0:
        assert wm_uid == desktop_owner.stdout.strip(), (openbox, desktop_owner.stdout)
    # The shell ran as the calling bot (A), under A's own uid, which owns A's tree.
    assert owner.stdout.strip() == uid_line, (owner.stdout, shell)
    status, _ = client.call("DELETE", f"/api/bots/{right}")
    assert status == 204, status
    after = subprocess.run(["sudo", "docker", "exec", name, "cat", host_path], capture_output=True, text=True)
    assert after.returncode != 0, after.stdout
    status, still = client.call("GET", f"/api/bots/{left}/files/raw?path=/workspace/notes/private.txt")
    assert status == 200 and secret.decode() in str(still), still
    client.call("DELETE", f"/api/bots/{left}")


def computer_api(name: str, method: str, path: str, payload: str | None = None):
    deadline = time.monotonic() + 45
    while True:
        status, body = _computer_api_once(name, method, path, payload)
        if status != "404" or "desktop not ready" not in body or time.monotonic() >= deadline:
            return status, body
        time.sleep(0.3)


def _computer_api_once(name: str, method: str, path: str, payload: str | None = None):
    script = """import json, os, sys, urllib.request, urllib.error
method, path, body = json.load(sys.stdin)
req = urllib.request.Request('http://127.0.0.1:7700' + path, method=method,
    data=None if body is None else body.encode(), headers={
        'Authorization': 'Bearer ' + os.environ['COMPUTER_TOKEN'], 'Content-Type': 'application/json'})
try:
    with urllib.request.urlopen(req, timeout=40) as response:
        print(json.dumps([str(response.status), response.read().decode()]))
except urllib.error.HTTPError as exc:
    print(json.dumps([str(exc.code), exc.read().decode()]))
"""
    result = subprocess.run(["sudo", "docker", "exec", "-i", name, "python3", "-c", script],
        input=json.dumps([method, path, payload]), capture_output=True, text=True, timeout=45)
    assert result.returncode == 0, "computer API request failed"
    return tuple(json.loads(result.stdout))


def json_text(body) -> str:
    if isinstance(body, str):
        return body
    import json
    return json.dumps(body)
