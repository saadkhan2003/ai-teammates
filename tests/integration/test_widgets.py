"""Typed widget messages and owner-scoped widget actions use the mock planner only."""
import uuid
from test_acceptance import login, submit, wait_task
from test_bot_messaging import _cleanup, _workspace


def test_mock_bot_streams_every_widget_type():
    client = login()
    status, bot = client.call("POST", "/api/bots", {"name": "Widgets" + uuid.uuid4().hex[:6], "role": "Test teammate"})
    assert status == 200, bot
    bot_id = bot["id"]
    try:
        ws = _workspace(client, bot_id)
        types = ["card", "list", "table", "form", "buttons", "badges", "key-value", "progress", "image-grid", "chart", "flow", "code"]
        for kind in types:
            task = submit(client, ws["conversationId"], "WIDGET_DEMO:" + kind)
            assert wait_task(client, bot_id, task)["status"] == "completed"
            ws = _workspace(client, bot_id)
            widget = next(p["widget"] for m in reversed(ws["messages"]) for p in (m.get("parts") or []) if p.get("type") == "widget" and p["widget"]["type"] == kind)
            assert widget["version"] == 1
    finally:
        _cleanup(client, bot_id)


def test_widget_action_schema_owner_and_approval_gate():
    client = login()
    status, bot = client.call("POST", "/api/bots", {"name": "WidgetAction" + uuid.uuid4().hex[:6], "role": "Test teammate"})
    assert status == 200, bot
    bot_id = bot["id"]
    try:
        ws = _workspace(client, bot_id)
        task = submit(client, ws["conversationId"], "WIDGET_DEMO:buttons")
        assert wait_task(client, bot_id, task)["status"] == "completed"
        payload = {"widget_id": "demo-buttons", "action": "not-declared", "payload": {}}
        assert client.call("POST", f"/api/bots/{bot_id}/widget-actions", payload)[0] == 400
        payload["action"] = "continue"
        status, accepted = client.call("POST", f"/api/bots/{bot_id}/widget-actions", payload)
        assert status == 200 and wait_task(client, bot_id, accepted["taskId"])["status"] == "completed"
        task = submit(client, ws["conversationId"], "WIDGET_DEMO:approval")
        assert wait_task(client, bot_id, task)["status"] == "completed"
        status, accepted = client.call("POST", f"/api/bots/{bot_id}/widget-actions", {"widget_id": "demo-approval", "action": "delete_item", "payload": {}})
        assert status == 200 and accepted["status"] == "waiting_approval" and accepted["approvalId"]
        assert any(a["id"] == accepted["approvalId"] for a in _workspace(client, bot_id)["approvals"])
    finally:
        _cleanup(client, bot_id)
