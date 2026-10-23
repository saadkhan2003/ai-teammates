"""Long-run checkpoint, pause, continuation, and approval recovery on the mock stack."""
import uuid

from test_acceptance import OPENROUTER, _psql, login
from test_bot_messaging import _bot, _cleanup, _workspace


def _setup():
    client = login()
    assert client.call("POST", "/api/secrets", {"namespace": "openrouter", "name": "default", "type": "API_KEY", "value": OPENROUTER})[0] == 200
    bot = _bot(client, "Resume" + uuid.uuid4().hex[:6])
    conversation = _workspace(client, bot)["conversationId"]
    task = _psql(
        "INSERT INTO tasks (bot_id,conversation_id,title,instruction,kind,status,waiting_reason,checkpoint) "
        f"VALUES ('{bot}','{conversation}','Resume test','original request','work','waiting_human','budget_reached','{{\"stepsUsed\":12}}'::jsonb) RETURNING id"
    ).splitlines()[0]
    return client, bot, conversation, task


def test_continue_raises_clamped_budget_and_audits_owner_action():
    client, bot, _, task = _setup()
    try:
        before_epoch = int(_psql(f"SELECT lease_epoch FROM tasks WHERE id='{task}'"))
        status, body = client.call("POST", f"/api/tasks/{task}/continue", {"extraSteps": 5000, "extraSeconds": 99999})
        assert status == 200, body
        assert body["maxSteps"] == 1000 and body["maxSeconds"] == 21600
        assert int(_psql(f"SELECT lease_epoch FROM tasks WHERE id='{task}'")) > before_epoch
        assert _psql(f"SELECT status FROM tasks WHERE id='{task}'") in {"queued", "running", "completed"}
        assert int(_psql(f"SELECT count(*) FROM audit_events WHERE task_id='{task}' AND action='task.budget_continue'")) == 1
        assert client.call("POST", f"/api/tasks/{task}/continue", {})[0] == 409
    finally:
        _cleanup(client, bot)


def test_next_chat_message_resumes_paused_task_and_appends_continuation():
    client, bot, conversation, task = _setup()
    try:
        status, result = client.call("POST", f"/api/conversations/{conversation}/messages", {"content": "Continue by checking the last result."})
        assert status == 200, result
        assert result["taskId"] == task and result["resumed"] is True
        row = _psql(f"SELECT status||':'||waiting_reason||':'||instruction FROM tasks WHERE id='{task}'")
        assert row.split(":", 2)[0] in {"queued", "running", "completed"}
        assert "User continuation: Continue by checking the last result." in row
        assert int(_psql(f"SELECT count(*) FROM audit_events WHERE task_id='{task}' AND action='task.resumed' AND detail->>'source'='user_message'")) == 1
    finally:
        _cleanup(client, bot)


def test_approval_resumes_even_with_an_expired_worker_lease_and_cancelled_never_resumes():
    client, bot, conversation, task = _setup()
    try:
        _psql(f"UPDATE tasks SET status='waiting_approval',waiting_reason='approval',lease_owner='dead-worker',lease_until=now()-interval '1 minute' WHERE id='{task}'")
        before_epoch = int(_psql(f"SELECT lease_epoch FROM tasks WHERE id='{task}'"))
        approval = _psql(
            "INSERT INTO approvals (bot_id,task_id,action,target,reason) "
            f"VALUES ('{bot}','{task}','write_file','/workspace/a','owner decision') RETURNING id"
        ).splitlines()[0]
        assert client.call("POST", f"/api/approvals/{approval}/decide", {"decision": "allow_once"})[0] == 200
        assert int(_psql(f"SELECT lease_epoch FROM tasks WHERE id='{task}'")) > before_epoch
        assert int(_psql(f"SELECT count(*) FROM audit_events WHERE task_id='{task}' AND action='task.resumed' AND detail->>'source'='approval'")) == 1

        cancelled = _psql(
            "INSERT INTO tasks (bot_id,conversation_id,title,instruction,kind,status,waiting_reason) "
            f"VALUES ('{bot}','{conversation}','Cancelled','cancelled','work','cancelled','user_cancelled') RETURNING id"
        ).splitlines()[0]
        status, result = client.call("POST", f"/api/conversations/{conversation}/messages", {"content": "A new unrelated message."})
        assert status == 200, result
        assert _psql(f"SELECT status FROM tasks WHERE id='{cancelled}'") == "cancelled"
    finally:
        _cleanup(client, bot)
