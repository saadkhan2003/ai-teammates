"""Two bots on one computer cannot read each other's workspace. Deleting a bot removes its files."""
from __future__ import annotations

import json
import os
import subprocess

from test_acceptance import login


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
    name = "tm" + str(computer["computerId"]).replace("-", "").lower()
    host_path = f"/data/workspace/bots/{right.replace('-', '')}/notes/own.txt"
    client.call(
        "PUT",
        f"/api/bots/{right}/files",
        raw=b"bot-b\n",
        headers={"x-path": "/workspace/notes/own.txt", "Content-Type": "application/octet-stream"},
    )
    before = subprocess.run(["sudo", "docker", "exec", name, "cat", host_path], capture_output=True, text=True)
    assert before.returncode == 0 and "bot-b" in before.stdout, before.stderr

    token = os.environ.get("COMPUTER_TOKEN", "dev-computer-token-change-me")
    # Bots on one computer share its single desktop, keyed by the computer id and fenced by an epoch.
    desktop = str(computer["computerId"])
    ensure_status, ensured = computer_api(
        name, "POST", "/desktops", token, json.dumps({"botId": desktop, "display": 1, "chrome": False})
    )
    assert ensure_status == "200", ensured
    epoch = json.loads(ensured)["epoch"]
    other_file = f"/desktops/{left}/files/raw?path=/workspace/notes/own.txt"
    status_line, body = computer_api(name, "GET", other_file, token)
    assert status_line != "200" or "bot-b" not in body, body
    shell_body = json.dumps({
        "command": f"id -u; cat /data/workspace/bots/{right.replace('-', '')}/notes/own.txt",
        "actor_id": "agent:workspace-isolation-test",
        "epoch": epoch,
    })
    shell_status, shell = computer_api(name, "POST", f"/desktops/{desktop}/shell", token, shell_body)
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
    assert wm_uid == desktop_owner.stdout.strip() and wm_uid != "0", (openbox, desktop_owner.stdout)
    assert desktop_owner.stdout.strip() == uid_line, (desktop_owner.stdout, shell)
    status, _ = client.call("DELETE", f"/api/bots/{right}")
    assert status == 204, status
    after = subprocess.run(["sudo", "docker", "exec", name, "cat", host_path], capture_output=True, text=True)
    assert after.returncode != 0, after.stdout
    status, still = client.call("GET", f"/api/bots/{left}/files/raw?path=/workspace/notes/private.txt")
    assert status == 200 and secret.decode() in str(still), still
    client.call("DELETE", f"/api/bots/{left}")


def computer_api(name: str, method: str, path: str, token: str, payload: str | None = None):
    args = [
        "sudo", "docker", "exec", name,
        "curl", "-sS", "-m", "40",
        "-H", f"Authorization: Bearer {token}",
        "-X", method,
    ]
    if payload is not None:
        args += ["-H", "Content-Type: application/json", "-d", payload]
    args += ["-w", "\n%{http_code}", "http://127.0.0.1:7700" + path]
    result = subprocess.run(args, capture_output=True, text=True)
    text = result.stdout or ""
    if "\n" not in text:
        raise AssertionError(result.stderr or text)
    body, status = text.rsplit("\n", 1)
    return status.strip(), body


def json_text(body) -> str:
    if isinstance(body, str):
        return body
    import json
    return json.dumps(body)
