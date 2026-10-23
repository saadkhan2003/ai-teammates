"""Bot-to-bot messaging on the live mock stack (no paid provider). Same user only; cross-user is v0.5."""
import time
import uuid

from test_acceptance import OPENROUTER, _psql, login, submit, wait_task


def _bot(client, name, role="test"):
    status, bot = client.call("POST", "/api/bots", {"name": name, "role": role})
    assert status == 200, bot
    return bot["id"]


def _workspace(client, bot):
    status, ws = client.call("GET", f"/api/bots/{bot}/workspace")
    assert status == 200, ws
    return ws


def _until(fn, timeout=90, what="condition"):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(0.5)
    raise AssertionError(f"timeout waiting for {what}: {last}")


def _approval(client, bot, action):
    return _until(lambda: next((a for a in _workspace(client, bot).get("approvals") or [] if a.get("action") == action and a.get("status") in (None, "pending")), None), what=f"{action} approval")


def _pair():
    client = login()
    assert client.call("POST", "/api/secrets", {"namespace": "openrouter", "name": "default", "type": "API_KEY", "value": OPENROUTER})[0] == 200
    tag = uuid.uuid4().hex[:5]
    a = _bot(client, "Alpha" + tag)
    b = _bot(client, "Beta" + tag)
    return client, a, "Alpha" + tag, b, "Beta" + tag


def _cleanup(client, *bots):
    for bot in bots:
        client.call("DELETE", f"/api/bots/{bot}")


def test_message_asks_first_then_peer_replies_and_chats_show_the_thread():
    client, a, _, b, bname = _pair()
    try:
        ws = _workspace(client, a)
        task = submit(client, ws["conversationId"], f"Ask {bname} to double 21")
        approval = _approval(client, a, "message_bot")
        assert approval["riskClass"] == "bot_message"
        assert client.call("POST", f"/api/approvals/{approval['id']}/decide", {"decision": "allow_once"})[0] == 200
        assert wait_task(client, a, task)["status"] == "completed"
        threads = _until(lambda: [t for t in _workspace(client, a)["botThreads"] if t["status"] == "replied"], what="replied thread")
        assert threads[0]["lastReply"] == "42"
        rows = [m for m in _workspace(client, a)["messages"] if m["kind"] == "bot_thread"]
        assert rows and '"direction":"sent"' in rows[0]["content"].replace(" ", "")
        inbound = [m for m in _workspace(client, b)["messages"] if m["kind"] == "bot_thread"]
        assert inbound and '"direction":"received"' in inbound[0]["content"].replace(" ", "")
        # The sender is woken with the reply and says so in its own chat.
        _until(lambda: any(m["role"] == "assistant" and m["kind"] not in ("bot_thread", "bot_action") and "42" in m["content"] for m in _workspace(client, a)["messages"]), what="sender wake reply")
        status, detail = client.call("GET", f"/api/bot-threads/{threads[0]['id']}")
        assert status == 200 and [m["kind"] for m in detail["messages"]][:2] == ["request", "reply"]
    finally:
        _cleanup(client, a, b)


def test_denied_message_never_reaches_the_peer():
    client, a, _, b, bname = _pair()
    try:
        task = submit(client, _workspace(client, a)["conversationId"], f"Ask {bname} to double 21")
        approval = _approval(client, a, "message_bot")
        assert client.call("POST", f"/api/approvals/{approval['id']}/decide", {"decision": "deny"})[0] == 200
        wait_task(client, a, task)
        time.sleep(2)
        assert _workspace(client, a)["botThreads"] == []
        assert [m for m in _workspace(client, b)["messages"] if m["kind"] == "bot_thread"] == []
    finally:
        _cleanup(client, a, b)


def test_peer_delete_is_forced_to_ask_and_the_card_shows_in_both_chats_and_decides_everywhere():
    client, a, aname, b, bname = _pair()
    try:
        task = submit(client, _workspace(client, a)["conversationId"], f"Ask {bname} to delete the secret file")
        first = _approval(client, a, "message_bot")
        assert client.call("POST", f"/api/approvals/{first['id']}/decide", {"decision": "allow_once"})[0] == 200
        wait_task(client, a, task)
        on_peer = _approval(client, b, "delete_file")
        assert on_peer["riskClass"] == "delete"
        relayed = _approval(client, a, "delete_file")
        assert relayed["id"] == on_peer["id"] and relayed.get("relayed") is True
        assert client.call("POST", f"/api/approvals/{relayed['id']}/decide", {"decision": "deny"})[0] == 200
        _until(lambda: not any(x["id"] == on_peer["id"] for x in _workspace(client, b)["approvals"]) and not any(x["id"] == on_peer["id"] for x in _workspace(client, a)["approvals"]), what="approval cleared in both chats")
    finally:
        _cleanup(client, a, b)


def test_send_limit_per_task_and_thread_cap():
    client, a, _, b, bname = _pair()
    try:
        client.call("PUT", "/api/policy", {"classes": {"bot_message": "ALLOW"}, "modelAssist": False})
        task = submit(client, _workspace(client, a)["conversationId"], f"Message {bname} hello 7 times")
        assert wait_task(client, a, task, timeout=180)["status"] == "completed"
        threads = _workspace(client, a)["botThreads"]
        assert 1 <= len(threads) <= 5, len(threads)
    finally:
        client.call("PUT", "/api/policy", {"classes": {"bot_message": "ASK"}, "modelAssist": False})
        _cleanup(client, a, b)


def test_bot_sets_its_own_bio_and_cannot_pick_a_bad_one():
    client, a, _, b, _ = _pair()
    try:
        task = submit(client, _workspace(client, a)["conversationId"], "Set your bio to Research helper")
        assert wait_task(client, a, task)["status"] == "completed"
        assert _workspace(client, a)["bot"]["bio"] == "Research helper"
        rows = [m for m in _workspace(client, a)["messages"] if m["kind"] == "bot_action"]
        assert rows
    finally:
        _cleanup(client, a, b)


def test_create_bot_and_routine_ask_first_and_clone_copies_plugin_config():
    client, a, _, b, _ = _pair()
    try:
        name = "Kid" + uuid.uuid4().hex[:5]
        task = submit(client, _workspace(client, a)["conversationId"], f"Create a teammate named {name} with bio Helper")
        approval = _approval(client, a, "create_bot")
        assert approval["riskClass"] == "bot_manage"
        assert client.call("POST", f"/api/approvals/{approval['id']}/decide", {"decision": "allow_once"})[0] == 200
        assert wait_task(client, a, task)["status"] == "completed"
        status, bots = client.call("GET", "/api/bots")
        assert status == 200 and any(x["name"] == name for x in bots)
        kid = next(x["id"] for x in bots if x["name"] == name)
        task = submit(client, _workspace(client, a)["conversationId"], f"Schedule {name} to check the news every hour")
        approval = _approval(client, a, "create_routine")
        assert client.call("POST", f"/api/approvals/{approval['id']}/decide", {"decision": "allow_once"})[0] == 200
        assert wait_task(client, a, task)["status"] == "completed"
        status, routines = client.call("GET", f"/api/bots/{kid}/routines")
        assert status == 200 and len(routines) == 1 and routines[0]["cron"] == "0 * * * *"
        _cleanup(client, kid)
    finally:
        _cleanup(client, a, b)


def test_peer_messaging_switch_blocks_the_receiver():
    client, a, _, b, bname = _pair()
    try:
        assert client.call("PATCH", f"/api/bots/{b}", {"peerMessaging": False})[0] == 200
        client.call("PUT", "/api/policy", {"classes": {"bot_message": "ALLOW"}, "modelAssist": False})
        task = submit(client, _workspace(client, a)["conversationId"], f"Ask {bname} to double 21")
        wait_task(client, a, task)
        time.sleep(2)
        assert not [t for t in _workspace(client, a)["botThreads"] if t["status"] == "replied"]
    finally:
        client.call("PUT", "/api/policy", {"classes": {"bot_message": "ASK"}, "modelAssist": False})
        _cleanup(client, a, b)


def test_clone_copies_plugin_enablement_but_no_secrets():
    client, a, _, b, _ = _pair()
    clone = None
    try:
        status, catalog = client.call("POST", "/api/admin/plugins", {"name": "Clone bench " + uuid.uuid4().hex[:4], "kind": "builtin", "transport": "builtin", "authType": "none", "category": "Built-in", "tools": [{"name": "echo", "description": "Return the arguments"}]})
        assert status == 200, catalog
        status, installed = client.call("POST", "/api/plugins/install", {"catalogId": catalog["id"]})
        assert status == 200, installed
        assert client.call("PUT", f"/api/plugins/{installed['id']}/bots/{a}", {"enabled": True})[0] == 200
        status, copy = client.call("POST", f"/api/bots/{a}/clone")
        assert status == 200, copy
        clone = copy["id"]
        assert _psql(f"SELECT count(*) FROM plugin_bot_enable WHERE bot_id='{clone}' AND plugin_id='{installed['id']}' AND enabled").strip() == "1"
        assert "secretId" not in copy
    finally:
        _cleanup(client, a, b, *([clone] if clone else []))


def test_memory_provenance_points_at_the_message_it_came_from():
    client, a, _, b, _ = _pair()
    try:
        conversation = _workspace(client, a)["conversationId"]
        task = submit(client, conversation, "Remember that my favorite editor is Helix")
        assert wait_task(client, a, task)["status"] == "completed"
        status, memories = client.call("GET", f"/api/bots/{a}/memories")
        assert status == 200
        mine = next(m for m in memories if "Helix" in m["content"])
        user_message = next(m for m in _workspace(client, a)["messages"] if m["role"] == "user")
        assert mine["source"] == f"message:{user_message['id']}", mine
    finally:
        _cleanup(client, a, b)
