"""Chat never shows raw tool output (a started job reads as prose), and the admin spend table
is grouped by owner with owner and bot names, ids for copy, and owner pagination."""
import time

from test_resources import _send
from test_acceptance import login
from test_bot_messaging import _workspace


def test_job_start_reply_is_prose(bot_factory):
    owner = login()
    bot = bot_factory(owner, "Prose job bot")
    task, messages = _send(owner, bot, "JOB DEMO 2")
    assert task["status"] == "completed", task
    reply = next(m for m in reversed(messages) if "background" in m)
    assert reply == "Started Tick demo in the background. I'll tell you when it's done.", messages[-3:]
    assert not any('"ok"' in m or '"job_id"' in m for m in messages), messages[-4:]
    deadline = time.time() + 60  # let the job finish so it does not hold the computer
    while time.time() < deadline:
        body = owner.call("GET", f"/api/bots/{bot}/jobs")[1]
        jobs = body.get("jobs", []) if isinstance(body, dict) else body
        if not any(j.get("status") in ("starting", "running") for j in jobs):
            break
        time.sleep(1)
    assert jobs and jobs[0]["status"] == "done", jobs
    time.sleep(2)
    after = [str(m.get("content") or "") for m in _workspace(owner, bot)["messages"]]
    assert not any('"ok"' in m or '"job_id"' in m for m in after), after[-4:]


def test_spend_grouped_named_and_paginated(bot_factory):
    owner = login()
    bot = bot_factory(owner, "Spend named bot")
    task, _ = _send(owner, bot, "SPEED TOOL DEMO")
    assert task["status"] == "completed", task
    status, first = owner.call("GET", "/api/admin/ai/spend?page=1&page_size=1")
    assert status == 200, first
    assert first["page"] == 1 and first["page_size"] == 1 and len(first["owners"]) == 1
    assert int(first["total_owners"]) >= 1 and float(first["total"]["month"]) >= float(first["owners"][0]["month"])
    _, wide = owner.call("GET", "/api/admin/ai/spend?page=1&page_size=50")
    mine = [b for o in wide["owners"] for b in o["bots"] if b["bot_id"] == bot]
    assert mine and mine[0]["bot_name"] == "Spend named bot", mine
    for o in wide["owners"]:
        assert o["owner_id"] and o["owner_name"], o
        assert abs(sum(float(b["month"]) for b in o["bots"]) - float(o["month"])) < 1e-6
    if int(first["total_owners"]) > 1:
        _, second = owner.call("GET", "/api/admin/ai/spend?page=2&page_size=1")
        assert second["owners"][0]["owner_id"] != first["owners"][0]["owner_id"]
    status, clamped = owner.call("GET", "/api/admin/ai/spend?page=0&page_size=500")
    assert status == 200 and clamped["page"] == 1 and clamped["page_size"] == 50
