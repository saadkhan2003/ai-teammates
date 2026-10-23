"""Coding work API coverage against the live mock stack."""
from __future__ import annotations

import uuid

from test_acceptance import Client, OPENROUTER, login, submit, wait_task, worker_call


def test_plan_demo_payload_and_work_settings_budget_validation_and_ownership():
    client = login()
    assert client.call("POST", "/api/secrets", {"namespace": "openrouter", "name": "default", "type": "API_KEY", "value": OPENROUTER})[0] == 200
    status, bot = client.call("POST", "/api/bots", {"name": "Coding plan", "role": "test"})
    assert status == 200, bot
    bot_id = bot["id"]
    try:
        _, ws = client.call("GET", f"/api/bots/{bot_id}/workspace")
        task = submit(client, ws["conversationId"], "PLAN DEMO")
        assert wait_task(client, bot_id, task)["status"] == "completed"
        status, plan = client.call("GET", f"/api/tasks/{task}/plan")
        assert status == 200 and len(plan["items"]) == 3 and plan["items"][0]["status"] == "done"
        assert plan["budget"]["maxSteps"] == 200 and "estimate" in plan
        assert client.call("PATCH", f"/api/bots/{bot_id}/work-settings", {"maxSteps": 1, "maxSeconds": 999999, "requireTests": True})[0] == 200
        assert client.call("PATCH", f"/api/tasks/{task}/budget", {"maxSteps": 1, "maxSeconds": 999999})[0] == 200
        assert client.call("PATCH", f"/api/tasks/{task}/budget", {"maxSteps": "invalid"})[0] >= 400
        other = Client()
        assert other.call("PATCH", f"/api/tasks/{task}/budget", {"maxSteps": 10})[0] in (401, 404)
        assert other.call("PATCH", f"/api/bots/{bot_id}/work-settings", {"maxSteps": 10})[0] in (401, 404)
    finally:
        client.call("DELETE", f"/api/bots/{bot_id}")


def test_override_tests_ownership_and_message_before_paging():
    owner = login()
    status, bot = owner.call("POST", "/api/bots", {"name": "Paging", "role": "test"})
    assert status == 200, bot
    bot_id = bot["id"]
    try:
        _, ws = owner.call("GET", f"/api/bots/{bot_id}/workspace")
        for i in range(3):
            owner.call("POST", f"/api/conversations/{ws['conversationId']}/messages", {"content": f"page-{uuid.uuid4()}-{i}", "asTask": False})
        status, page = owner.call("GET", f"/api/bots/{bot_id}/messages?limit=2")
        assert status == 200 and len(page["messages"]) == 2 and page["hasMore"]
        cursor = page["messages"][-1]["id"]
        status, older = owner.call("GET", f"/api/bots/{bot_id}/messages?limit=2&before={cursor}")
        assert status == 200 and older["messages"]
        task_id = str(uuid.uuid4())
        other = Client()
        assert other.call("POST", f"/api/tasks/{task_id}/override-tests")[0] in (401, 404)
    finally:
        owner.call("DELETE", f"/api/bots/{bot_id}")
