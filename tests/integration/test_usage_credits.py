"""Unified usage meter: allowance, pause of heavy work, on-demand, admin breakdown (mock LLM, isolated stack only)."""
import os
import time
import uuid

import pytest

from test_acceptance import OPENROUTER, Client, _psql, login, wait_task
from test_bot_messaging import _workspace

pytestmark = pytest.mark.skipif(os.environ.get("LLM_PROVIDER") != "mock", reason="requires an isolated mock stack")

PLAN = "itest-zero"
FORBIDDEN = ("openrouter", "anthropic", "openai", "claude", "gpt-", "gemini", "llama", "mistral", "qwen", "deepseek", "grok")


@pytest.fixture
def tiny_owner():
    staff = login()
    _psql(f"INSERT INTO billing_plans (id,name,price_usd,weekly_credits,on_demand_cap_usd,job_default_minutes,job_max_minutes,max_running_jobs,upgrade_to,sort) "
          f"VALUES ('{PLAN}','Test Zero',30,0,50,5,10,2,'pro',99) ON CONFLICT (id) DO UPDATE SET weekly_credits=0,on_demand_cap_usd=50")
    tag = uuid.uuid4().hex[:10]
    status, invite = staff.call("POST", "/api/invitations", {"email": f"credits-{tag}@example.test", "role": "member"})
    assert status == 200
    client = Client()
    status, account = client.call("POST", "/api/invitations/accept", {
        "token": invite["token"], "username": f"credits-{tag}", "password": "credits-fixture-only-pass"}, auth=False)
    assert status == 200
    assert client.call("POST", "/api/secrets", {"namespace": "openrouter", "name": "default", "type": "API_KEY", "value": OPENROUTER})[0] == 200
    try:
        yield client, staff, account["id"]
    finally:
        staff.call("PUT", f"/api/admin/billing/plans/standard/assign/{account['id']}")
        staff.call("PATCH", f"/api/admin/users/{account['id']}", {"status": "disabled"})


def _until(fn, timeout=60, what="condition"):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(1)
    raise AssertionError(f"timed out waiting for {what}: {last}")


def _send(client, bot, text):
    conversation = _workspace(client, bot)["conversationId"]
    status, sent = client.call("POST", f"/api/conversations/{conversation}/messages", {"content": text, "client_id": str(uuid.uuid4())})
    assert status == 200, sent
    return sent


def test_credit_meter_pauses_heavy_work_and_on_demand_resumes(tiny_owner, bot_factory):
    client, staff, user_id = tiny_owner
    status, fresh = client.call("GET", "/api/usage/credits")
    assert status == 200 and fresh["credits"]["planId"] == "standard" and fresh["credits"]["allowance"] == 4500
    assert fresh["credits"]["paused"] is False and fresh["message"] is None
    assert fresh["onDemandOptions"] == [10, 25, 50, 100]
    assert fresh["upgrade"]["id"] == "pro"

    bot = bot_factory(client, "Credits " + uuid.uuid4().hex[:6])
    assert staff.call("PUT", f"/api/admin/billing/plans/{PLAN}/assign/{user_id}")[0] == 200
    status, paused = client.call("GET", "/api/usage/credits")
    assert status == 200 and paused["credits"]["paused"] is True and paused["credits"]["state"] == "paused"
    assert "Usage & Billing" in paused["message"] and "Chat still works" in paused["message"]
    assert paused["credits"]["resetsInDays"] in range(0, 8)
    text = (paused["message"] or "").lower()
    assert not any(name in text for name in FORBIDDEN)

    # New background jobs are paused; chat still answers and explains how to top up.
    sent = _send(client, bot, "JOB DEMO 2")
    task = wait_task(client, bot, sent["taskId"])
    assert task["status"] in {"completed", "failed"}
    status, jobs = client.call("GET", f"/api/bots/{bot}/jobs")
    assert status == 200 and jobs["jobs"] == []
    messages = [str(m.get("content") or "") for m in _workspace(client, bot)["messages"]]
    notices = [m for m in messages if "this week's included usage" in m and not m.lstrip().startswith("{") and "\\u2192" not in m]
    assert len(notices) == 1, messages[-4:]  # one plain system notice per task (the mock model may also echo the tool result)
    assert int(_psql(f"SELECT count(*) FROM audit_events WHERE action='usage.paused' AND task_id='{sent['taskId']}'")) >= 1

    # Waking the computer by opening a terminal is blocked with a clear code.
    status, computer = client.call("GET", "/api/computer")
    if status == 200 and computer.get("computerId"):
        status, body = client.call("POST", f"/api/computers/{computer['computerId']}/terminal-ticket", {"botId": bot, "window": 1})
        # A computer that is already awake stays viewable (only waking is paused); a sleeping one is refused with 402.
        assert status == 402 or (status == 200 and computer.get("status") in {"running", "ready", "awake"}), (status, computer.get("status"))
        if status == 402:
            assert body["error"] == "usage_limit"

    # On-demand: above the plan cap is refused; a valid limit resumes heavy work. Nothing is charged.
    assert client.call("PUT", "/api/usage/on-demand", {"limitUsd": 1000})[0] == 400
    assert client.call("PUT", "/api/usage/on-demand", {"limitUsd": "ten"})[0] == 400
    status, body = client.call("PUT", "/api/usage/on-demand", {"limitUsd": 10})
    assert status == 200 and body["credits"]["paused"] is False and body["credits"]["state"] == "on_demand"
    assert _psql(f"SELECT detail->>'charged' FROM audit_events WHERE action='usage.on_demand.set' AND actor='{user_id}' ORDER BY id DESC LIMIT 1").strip() == "false"
    sent = _send(client, bot, "JOB DEMO 2")
    assert wait_task(client, bot, sent["taskId"])["status"] == "completed"
    _until(lambda: client.call("GET", f"/api/bots/{bot}/jobs")[1]["jobs"], 30, "job started after on-demand")

    status, body = client.call("PUT", "/api/usage/on-demand", {"limitUsd": None})
    assert status == 200 and body["credits"]["paused"] is True

    status, body = client.call("POST", "/api/usage/plan-request", {"planId": "pro"})
    assert status == 200 and "nothing has been charged" in body["message"]
    assert client.call("POST", "/api/usage/plan-request", {"planId": "nope"})[0] == 400


def test_admin_billing_is_staff_only_and_shows_per_user_breakdown(tiny_owner):
    client, staff, user_id = tiny_owner
    assert client.call("GET", "/api/admin/billing")[0] in {401, 403}
    assert client.call("GET", "/api/admin/billing/usage")[0] in {401, 403}
    status, config = staff.call("GET", "/api/admin/billing")
    assert status == 200
    standard = next(p for p in config["plans"] if p["id"] == "standard")
    assert standard["priceUsd"] == 30 and standard["weeklyCredits"] > 0
    assert config["rates"]["usdPerCredit"] > 0
    assert staff.call("PUT", f"/api/admin/billing/plans/{PLAN}", {"weeklyCredits": -1})[0] == 400
    assert staff.call("PUT", f"/api/admin/billing/plans/{PLAN}", {"jobDefaultMinutes": 20, "jobMaxMinutes": 10})[0] == 400
    assert staff.call("PUT", f"/api/admin/billing/plans/{PLAN}", {"weeklyCredits": 0, "maxRunningJobs": 2})[0] == 200
    status, usage = staff.call("GET", "/api/admin/billing/usage")
    assert status == 200
    row = next(u for u in usage["users"] if u["id"] == user_id)
    for key in ("ai", "computer", "storage", "used", "allowance", "percent", "computerMinutes", "backgroundMinutes", "state"):
        assert key in row
    assert abs(row["used"] - (row["ai"] + row["computer"] + row["storage"])) < 0.01
