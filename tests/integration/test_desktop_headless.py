"""Headless-by-default computers (mock LLM, isolated stack only).

A computer starts with no desktop. Jobs and live log streaming run headless;
a browser tool wakes the desktop; the idle timer (or an explicit sleep) stops
Chrome and the desktop while the computer and its jobs keep running.
"""
import os
import subprocess
import time
import urllib.request
import uuid

import pytest

from test_acceptance import BASE, _psql, approve, computer_slug, wait_task
from test_computer_jobs import _job, _send, _until, owner  # noqa: F401  (fixture)

pytestmark = pytest.mark.skipif(os.environ.get("LLM_PROVIDER") != "mock", reason="requires an isolated mock stack")

DESKTOP_PROCS = ("Xvfb", "chromium", "chrome")


def _exec(name, *argv, check=False):
    return subprocess.run(["sudo", "-n", "docker", "exec", name, *argv], capture_output=True, text=True, timeout=60, check=check)


def _desktop_procs(name):
    found = []
    for proc in DESKTOP_PROCS:
        if _exec(name, "pgrep", "-x", proc).returncode == 0:
            found.append(proc)
    return found


def _computer_env(name, key):
    out = _exec(name, "printenv", key)
    return out.stdout.strip() if out.returncode == 0 else ""


def _sleep_desktop(name, bot):
    # The computer token stays inside the container; nothing is printed.
    code = ("import os,urllib.request as u;r=u.Request('http://127.0.0.1:7700/desktops/%s/sleep',data=b'{}',method='POST',"
            "headers={'Authorization':'Bearer '+os.environ['COMPUTER_TOKEN'],'Content-Type':'application/json'});"
            "print(u.urlopen(r,timeout=30).status)") % bot
    return _exec(name, "python3", "-c", code).stdout.strip()


def _stream_lines(client, job_id, seconds=6):
    request = urllib.request.Request(f"{BASE}/api/jobs/{job_id}/log/stream", headers={"Cookie": client.cookie, "Accept": "text/event-stream"})
    lines, deadline = [], time.time() + seconds
    with urllib.request.urlopen(request, timeout=seconds + 10) as response:
        assert "text/event-stream" in (response.headers.get("Content-Type") or "")
        while time.time() < deadline:
            line = response.readline().decode(errors="replace")
            if not line:
                break
            if line.startswith("data:"):
                lines.append(line[5:].strip())
    return lines


def test_headless_job_stream_browser_wake_idle_sleep_and_job_survives(owner, bot_factory):  # noqa: F811
    client, _, owner_id = owner
    bot = bot_factory(client, "Headless " + uuid.uuid4().hex[:6])
    sent = _send(client, bot, "JOB LONG DEMO")
    assert wait_task(client, bot, sent["taskId"])["status"] == "completed"
    job = _until(lambda: (lambda j: j if j and j["status"] == "running" else None)(_job(client, bot, "Long demo")[0]), 60, "job running")
    name = computer_slug(client, bot)
    desktop_bot = _psql(f"SELECT desktop_bot_id FROM user_computers WHERE user_id='{owner_id}' AND status='running' LIMIT 1").strip()
    assert desktop_bot

    # 1) The job runs with no desktop process at all.
    assert _computer_env(name, "DESKTOP_LAZY") in ("", "true", "1")
    assert _desktop_procs(name) == [], "desktop started for a headless job"
    status, state = client.call("GET", "/api/computer/desktop")
    assert status == 200 and state["desktop"] == "asleep", state

    # 2) Streaming the live log is quiet: output arrives, the desktop stays off.
    lines = _stream_lines(client, job["id"])
    assert any("working" in line for line in lines), lines[-5:]
    assert _desktop_procs(name) == [], "log streaming woke the desktop"

    # 3) A browser tool wakes the desktop and Chrome on demand.
    sent = _send(client, bot, "Open http://evil.example:8099/hidden.html and extract the h1")
    # Waiting for approval is not desktop use either.
    _until(lambda: any(t["id"] == sent["taskId"] and t["status"] == "waiting_approval" for t in client.call("GET", f"/api/bots/{bot}/tasks")[1]), 60, "browser approval")
    assert _desktop_procs(name) == [], "an approval prompt woke the desktop"
    approve(client, bot, "browser_open")
    _until(lambda: {"Xvfb"} <= set(_desktop_procs(name)) and any(p in _desktop_procs(name) for p in ("chromium", "chrome")), 60, "desktop awake")
    _until(lambda: client.call("GET", "/api/computer/desktop")[1].get("desktop") == "on", 30, "desktop on in API")

    # 4) The idle timer stops Chrome, then the desktop. With a short idle window
    # wait for the real reaper; otherwise ask the same sleep path directly.
    idle = int(_computer_env(name, "DESKTOP_IDLE_SECONDS") or 300)
    if idle <= 60:
        _until(lambda: _desktop_procs(name) == [], idle + 60, "idle reaper stops the desktop")
    else:
        assert _sleep_desktop(name, desktop_bot) == "200"
        _until(lambda: _desktop_procs(name) == [], 30, "desktop stopped")
    # The state flips once both services are fully down (Chrome first, then the desktop).
    _until(lambda: client.call("GET", "/api/computer/desktop")[1].get("desktop") == "asleep", 30, "desktop asleep in API")

    # 5) The running job survived the desktop stopping and keeps writing output.
    job_now, _ = _job(client, bot, "Long demo")
    assert job_now["status"] == "running", job_now
    before = client.call("GET", f"/api/jobs/{job['id']}/log")[1]["log"].count("working")
    time.sleep(3)
    after = client.call("GET", f"/api/jobs/{job['id']}/log")[1]["log"].count("working")
    assert after > before or after >= 1000, (before, after)
    assert _desktop_procs(name) == []
    assert client.call("POST", f"/api/jobs/{job['id']}/cancel")[0] == 200
