"""Background jobs on the bot computer (mock LLM, isolated speed stack only)."""
import os
import time
import uuid

import pytest

from test_acceptance import OPENROUTER, Client, _psql, login, wait_task
from test_bot_messaging import _workspace

pytestmark = pytest.mark.skipif(os.environ.get("LLM_PROVIDER") != "mock", reason="requires an isolated mock stack")


def _until(fn, timeout=90, what="condition"):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(1)
    raise AssertionError(f"timed out waiting for {what}: {last}")


@pytest.fixture
def owner():
    staff = login()
    tag = uuid.uuid4().hex[:10]
    status, invite = staff.call("POST", "/api/invitations", {"email": f"jobs-{tag}@example.test", "role": "member"})
    assert status == 200
    client = Client()
    status, account = client.call("POST", "/api/invitations/accept", {
        "token": invite["token"], "username": f"jobs-{tag}", "password": "jobs-fixture-only-pass"}, auth=False)
    assert status == 200
    assert client.call("POST", "/api/secrets", {"namespace": "openrouter", "name": "default", "type": "API_KEY", "value": OPENROUTER})[0] == 200
    try:
        yield client, staff, account["id"]
    finally:
        staff.call("PATCH", f"/api/admin/users/{account['id']}", {"status": "disabled"})


def _send(client, bot, text):
    conversation = _workspace(client, bot)["conversationId"]
    status, sent = client.call("POST", f"/api/conversations/{conversation}/messages", {"content": text, "client_id": str(uuid.uuid4())})
    assert status == 200, sent
    return sent


def _job(client, bot, name):
    status, body = client.call("GET", f"/api/bots/{bot}/jobs")
    assert status == 200, body
    return next((job for job in body["jobs"] if job["name"] == name), None), body


def _messages(client, bot):
    return [str(m.get("content") or "") for m in _workspace(client, bot)["messages"]]


def test_job_runs_in_background_posts_notice_and_saves_result(owner, bot_factory):
    client, _, owner_id = owner
    bot = bot_factory(client, "Jobs " + uuid.uuid4().hex[:6])
    sent = _send(client, bot, "JOB DEMO 4")
    task = wait_task(client, bot, sent["taskId"])
    assert task["status"] == "completed", task
    job, body = _until(lambda: (lambda pair: pair if pair[0] else None)(_job(client, bot, "Tick demo")), 30, "job row")
    # While it runs, the computer counts as busy and the list shows it running.
    assert job["maxSeconds"] == 300
    done = _until(lambda: (lambda j: j if j and j[0]["status"] == "done" else None)(_job(client, bot, "Tick demo")), 90, "job done")[0]
    assert done["exitCode"] == 0 and done["elapsedSeconds"] >= 3
    status, log = client.call("GET", f"/api/jobs/{done['id']}/log")
    assert status == 200 and "tick 4" in log["log"] and "finished" in log["log"]
    _until(lambda: any("Background job “Tick demo” finished" in m for m in _messages(client, bot)), 30, "done notice in chat")
    assert _psql(f"SELECT count(*) FROM audit_events WHERE action='job.done' AND detail->>'job'='{done['id']}'").strip() == "1"
    # Job seconds count toward the unified meter as background computer minutes.
    _until(lambda: int(_psql(f"SELECT count(*) FROM computer_usage_minutes WHERE owner_id='{owner_id}' AND background") or 0) >= 1, 60, "background minute")
    status, jobs = client.call("GET", f"/api/bots/{bot}/jobs")
    assert status == 200 and jobs["running"] == 0


def test_job_stops_at_max_run_time(owner, bot_factory):
    client, _, _ = owner
    bot = bot_factory(client, "Jobs timeout " + uuid.uuid4().hex[:6])
    sent = _send(client, bot, "JOB TIMEOUT DEMO")
    assert wait_task(client, bot, sent["taskId"])["status"] == "completed"
    job = _until(lambda: (lambda j: j if j and j[0]["status"] not in {"starting", "running"} else None)(_job(client, bot, "Timeout demo")), 120, "timeout")[0]
    assert job["status"] == "timed_out" and job["reason"] == "max_run_time"
    assert 28 <= job["elapsedSeconds"] <= 75
    _until(lambda: any("hit its time limit" in m for m in _messages(client, bot)), 30, "timeout notice")


def test_user_can_stop_a_running_job_and_idle_sleep_waits(owner, bot_factory):
    client, _, _ = owner
    bot = bot_factory(client, "Jobs stop " + uuid.uuid4().hex[:6])
    sent = _send(client, bot, "JOB LONG DEMO")
    assert wait_task(client, bot, sent["taskId"])["status"] == "completed"
    job = _until(lambda: (lambda j: j if j and j[0]["status"] == "running" else None)(_job(client, bot, "Long demo")), 60, "running")[0]
    status, body = client.call("GET", f"/api/bots/{bot}/jobs")
    assert body["running"] == 1
    # Another user cannot read or stop it.
    stranger = login()
    assert stranger.call("POST", f"/api/jobs/{job['id']}/cancel")[0] == 404
    assert stranger.call("GET", f"/api/jobs/{job['id']}/log")[0] == 404
    status, _ = client.call("POST", f"/api/jobs/{job['id']}/cancel")
    assert status == 200
    stopped = _until(lambda: (lambda j: j if j and j[0]["status"] == "cancelled" else None)(_job(client, bot, "Long demo")), 30, "cancelled")[0]
    assert stopped["finishedAt"]
    _until(lambda: any("was stopped after" in m for m in _messages(client, bot)), 30, "stop notice")
