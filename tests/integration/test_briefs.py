"""Orchestrator-only: structured briefs against the isolated mock stack; never paid models."""
import json
import time
import uuid
from test_acceptance import OPENROUTER, _psql, login, submit, worker_call
from test_bot_messaging import _bot, _cleanup, _workspace


def test_brief_seed_contract_steer_and_failure_lesson():
    client = login()
    bot = _bot(client, "BriefSeed" + uuid.uuid4().hex[:5])
    try:
        conversation = _workspace(client, bot)["conversationId"]
        status, seeded = client.call("POST", "/api/test/briefs/seed", {"botId": bot, "conversationId": conversation})
        assert status == 200, seeded
        task = seeded["taskId"]
        status, brief = client.call("GET", f"/api/tasks/{task}/brief")
        assert status == 200 and brief["quality"]["passed"] and brief["version"] == 1
        assert brief["thoughtSeconds"] == 4.25 and brief["references"] and "## Verification" in brief["markdown"]
        message = next(m for m in _workspace(client, bot)["messages"] if m["id"] == seeded["messageId"])
        assert any(c["taskId"] == task and c["hasBrief"] for c in message["childTasks"])
        for text in ("", " ", "x" * 4001):
            assert client.call("POST", f"/api/tasks/{task}/brief/steer", {"text": text})[0] == 400
        status, steering = client.call("POST", f"/api/tasks/{task}/brief/steer", {"text": "Keep light theme and attach both crops."})
        assert status == 202 and steering["id"] and steering["createdAt"]
        assert client.call("GET", f"/api/tasks/{task}/brief")[1]["steering"][0]["text"] == steering["text"]
        assert client.call("POST", f"/api/tasks/{task}/cancel")[0] == 200
        lessons = client.call("GET", f"/api/bots/{bot}/brief-lessons")[1]
        assert {l["source"] for l in lessons} >= {"steer", "failed_run"}
    finally:
        _cleanup(client, bot)


def test_planner_repairs_rejected_brief_and_failed_child_teaches_only_its_bot():
    client = login()
    bot = _bot(client, "BriefFlow" + uuid.uuid4().hex[:5])
    try:
        assert client.call("POST", "/api/secrets", {"namespace": "openrouter", "name": "default", "type": "API_KEY", "value": OPENROUTER})[0] == 200
        parent = submit(client, _workspace(client, bot)["conversationId"], "BRIEF_TEST")
        child = None
        deadline = time.time() + 150
        while time.time() < deadline:
            ws = _workspace(client, bot)
            for approval in ws.get("approvals", []):
                if approval.get("status") in (None, "pending") and approval.get("action") in ("shell", "spawn_child_task"):
                    assert client.call("POST", f"/api/approvals/{approval['id']}/decide", {"decision": "allow_once"})[0] == 200
            ids = _psql(f"SELECT task_id FROM task_briefs WHERE parent_task_id='{parent}'")
            if ids:
                child = ids.splitlines()[0]
                status, brief = client.call("GET", f"/api/tasks/{child}/brief")
                assert status == 200 and brief["brief"]["acceptance"][0]["check"]
                if brief["status"] == "failed": break
            parent_status = _psql(f"SELECT status FROM tasks WHERE id='{parent}'")
            assert parent_status != "failed", "Parent failed before creating a repaired brief"
            time.sleep(.5)
        assert child, "The repaired brief did not create a child"
        assert "brief_rejected" in _psql(f"SELECT result::text FROM task_steps WHERE task_id='{parent}' AND tool='spawn_child_task'")
        assert client.call("GET", f"/api/tasks/{child}/brief")[1]["status"] == "failed"
        lessons = client.call("GET", f"/api/bots/{bot}/brief-lessons")[1]
        assert any(l["source"] == "failed_run" and l["sourceTaskId"] == child for l in lessons)
    finally:
        _cleanup(client, bot)
