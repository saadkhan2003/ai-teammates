"""Persistent approval rules stay narrow, owner-scoped, and revocable."""
import time
import uuid

from test_acceptance import OPENROUTER, Client, _psql, login, submit, wait_task, worker_call
from test_bot_messaging import _cleanup, _workspace


def _setup():
    client = login()
    assert client.call("POST", "/api/secrets", {"namespace": "openrouter", "name": "default", "type": "API_KEY", "value": OPENROUTER})[0] == 200
    status, bot = client.call("POST", "/api/bots", {"name": "ApprovalRules" + uuid.uuid4().hex[:5], "role": "test"})
    assert status == 200, bot
    return client, bot["id"]


def _until(fn, timeout=90):
    end = time.time() + timeout
    while time.time() < end:
        value = fn()
        if value:
            return value
        time.sleep(.5)
    raise AssertionError("timed out waiting for approval state")


def _pending(client, bot, action):
    return _until(lambda: next((a for a in _workspace(client, bot)["approvals"] if a["action"] == action and a["status"] == "pending"), None))


def test_always_allow_browser_rule_is_used_then_revoke_restores_prompt():
    client, bot = _setup()
    try:
        ws = _workspace(client, bot)
        prompt = "Open http://portal.example.edu:8099/alpha.html and extract the h1"
        first = submit(client, ws["conversationId"], prompt)
        approval = _pending(client, bot, "browser_open")
        status, decided = client.call("POST", f"/api/approvals/{approval['id']}/decide", {"decision": "allow_always"})
        assert status == 200, decided
        assert wait_task(client, bot, first)["status"] == "completed"
        status, rules = client.call("GET", "/api/approval-rules")
        assert status == 200 and len(rules) == 1
        rule = rules[0]
        assert rule["matcher"]["host"] == "portal.example.edu"
        other_name = "rule-reader-" + uuid.uuid4().hex[:6]
        other_password = "integration-password"
        worker_call("POST", "/internal/test/users", {"username": other_name, "password": other_password})
        other = Client()
        assert other.call("POST", "/api/auth/login", {"username": other_name, "password": other_password}, auth=False)[0] == 200
        assert other.call("PATCH", f"/api/approval-rules/{rule['id']}", {"botId": None})[0] == 404
        assert other.call("DELETE", f"/api/approval-rules/{rule['id']}")[0] == 404
        second = submit(client, ws["conversationId"], prompt)
        assert wait_task(client, bot, second)["status"] == "completed"
        status, rules = client.call("GET", "/api/approval-rules")
        assert status == 200 and rules[0]["useCount"] >= 1
        assert client.call("DELETE", f"/api/approval-rules/{rule['id']}")[0] == 200
        third = submit(client, ws["conversationId"], prompt)
        _pending(client, bot, "browser_open")
        assert wait_task(client, bot, third)["status"] == "waiting_approval"
    finally:
        _cleanup(client, bot)


def test_never_list_and_cross_owner_approval_rule_access_are_refused():
    client, bot = _setup()
    try:
        ws = _workspace(client, bot)
        task = submit(client, ws["conversationId"], "Delete the file /workspace/secret.txt")
        approval = _pending(client, bot, "delete_file")
        status, denied = client.call("POST", f"/api/approvals/{approval['id']}/decide", {"decision": "allow_always"})
        assert status == 400 and denied["error"] == "not_allowed_for_class"
        assert _psql(f"SELECT count(*) FROM approval_rules WHERE owner_id=(SELECT owner_id FROM bots WHERE id='{bot}') AND revoked_at IS NULL") == "0"
        assert wait_task(client, bot, task)["status"] == "waiting_approval"
    finally:
        _cleanup(client, bot)
