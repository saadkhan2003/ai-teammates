"""Bot routine tools: read before edit, approval cards, pause without a card, one-off reminders."""
import datetime as dt
import uuid

from test_acceptance import submit, wait_task
from test_bot_messaging import _approval, _cleanup, _pair, _until, _workspace


def _routine(client, bot, name, cron="0 8 * * *"):
    status, body = client.call("POST", f"/api/bots/{bot}/routines", {"name": name, "cron": cron, "instruction": "Say hi."})
    assert status == 200, body
    return body["id"]


def _get(client, rid):
    status, body = client.call("GET", f"/api/routines/{rid}")
    assert status == 200, body
    return body


def _no_approval(client, bot, action):
    return not any(a.get("action") == action and a.get("status") in (None, "pending") for a in _workspace(client, bot).get("approvals") or [])


def test_update_reads_first_then_asks_with_the_schedule_in_words():
    client, a, _, b, _ = _pair()
    try:
        name = "Brief" + uuid.uuid4().hex[:4]
        rid = _routine(client, a, name)
        task = submit(client, _workspace(client, a)["conversationId"], f"Reschedule routine {name} to 30 9 * * *")
        approval = _approval(client, a, "update_routine")
        assert approval["riskClass"] == "bot_manage"
        assert "Update routine" in approval["summary"] and "9:30 AM" in approval["summary"]
        assert client.call("POST", f"/api/approvals/{approval['id']}/decide", {"decision": "allow_once"})[0] == 200
        assert wait_task(client, a, task)["status"] == "completed"
        got = _get(client, rid)
        assert got["cron"] == "30 9 * * *" and "04:30" <= got["nextRunAt"][11:16] <= "04:45"
    finally:
        _cleanup(client, a, b)


def test_update_without_reading_is_refused_before_any_card():
    client, a, _, b, _ = _pair()
    try:
        name = "Blind" + uuid.uuid4().hex[:4]
        rid = _routine(client, a, name)
        task = submit(client, _workspace(client, a)["conversationId"], f"Reschedule routine {name} blind to 30 9 * * *")
        assert wait_task(client, a, task)["status"] == "completed"
        assert _no_approval(client, a, "update_routine")
        assert _get(client, rid)["cron"] == "0 8 * * *"
    finally:
        _cleanup(client, a, b)


def test_pause_needs_no_card_resume_and_delete_ask():
    client, a, _, b, _ = _pair()
    try:
        name = "Cycle" + uuid.uuid4().hex[:4]
        rid = _routine(client, a, name)
        conv = _workspace(client, a)["conversationId"]
        task = submit(client, conv, f"Pause routine {name}")
        assert wait_task(client, a, task)["status"] == "completed"
        assert _get(client, rid)["enabled"] is False
        task = submit(client, conv, f"Resume routine {name}")
        approval = _approval(client, a, "resume_routine")
        assert client.call("POST", f"/api/approvals/{approval['id']}/decide", {"decision": "allow_once"})[0] == 200
        assert wait_task(client, a, task)["status"] == "completed"
        assert _get(client, rid)["enabled"] is True
        task = submit(client, conv, f"Delete routine {name}")
        approval = _approval(client, a, "delete_routine")
        assert "Delete routine" in approval["summary"]
        assert client.call("POST", f"/api/approvals/{approval['id']}/decide", {"decision": "allow_once"})[0] == 200
        assert wait_task(client, a, task)["status"] == "completed"
        assert client.call("GET", f"/api/routines/{rid}")[0] == 404
    finally:
        _cleanup(client, a, b)


def test_denied_delete_keeps_the_routine():
    client, a, _, b, _ = _pair()
    try:
        name = "Keep" + uuid.uuid4().hex[:4]
        rid = _routine(client, a, name)
        task = submit(client, _workspace(client, a)["conversationId"], f"Delete routine {name}")
        approval = _approval(client, a, "delete_routine")
        assert client.call("POST", f"/api/approvals/{approval['id']}/decide", {"decision": "deny"})[0] == 200
        wait_task(client, a, task)
        assert client.call("GET", f"/api/routines/{rid}")[0] == 200
    finally:
        _cleanup(client, a, b)


def test_remind_me_creates_a_one_off_for_itself():
    client, a, _, b, _ = _pair()
    try:
        task = submit(client, _workspace(client, a)["conversationId"], "Remind me in 45 minutes to stretch")
        approval = _approval(client, a, "create_routine")
        assert client.call("POST", f"/api/approvals/{approval['id']}/decide", {"decision": "allow_once"})[0] == 200
        assert wait_task(client, a, task)["status"] == "completed"
        status, routines = client.call("GET", f"/api/bots/{a}/routines")
        assert status == 200 and len(routines) == 1
        assert routines[0]["kind"] == "once" and routines[0]["enabled"] is True and routines[0]["human"].startswith("Once on")
    finally:
        _cleanup(client, a, b)
