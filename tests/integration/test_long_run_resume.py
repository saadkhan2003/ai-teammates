"""Long-run checkpoint, pause, continuation, and approval recovery on the mock stack."""
import json
import time
import urllib.error
import urllib.request
import uuid

from test_acceptance import API, OPENROUTER, WORKER, _psql, login
from test_bot_messaging import _bot, _workspace

_CREATED_BOTS = set()


def _setup():
    client = login()
    assert client.call("POST", "/api/secrets", {"namespace": "openrouter", "name": "default", "type": "API_KEY", "value": OPENROUTER})[0] == 200
    status, bots = client.call("GET", "/api/bots")
    assert status == 200, bots
    reusable = next((item for item in bots if item.get("name", "").startswith("Resume ")), None)
    if reusable:
        bot = reusable["id"]
    else:
        bot = _bot(client, "Resume " + uuid.uuid4().hex[:6])
        _CREATED_BOTS.add(bot)
    conversation = _workspace(client, bot)["conversationId"]
    task = _psql(
        "INSERT INTO tasks (bot_id,conversation_id,title,instruction,kind,status,waiting_reason,checkpoint) "
        f"VALUES ('{bot}','{conversation}','Resume test','original request','work','waiting_human','budget_reached','{{\"stepsUsed\":12}}'::jsonb) RETURNING id"
    ).splitlines()[0]
    return client, bot, conversation, task


def _cleanup(client, bot, task):
    # Reuse the isolated stack's existing resume bot when computer capacity is full.
    _psql(f"DELETE FROM tasks WHERE id='{task}' AND bot_id='{bot}'")
    if bot in _CREATED_BOTS:
        _CREATED_BOTS.remove(bot)
        client.call("DELETE", f"/api/bots/{bot}")


def _wait_for(sql, expected, timeout=30):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = _psql(sql)
        if last == expected:
            return last
        time.sleep(0.5)
    raise AssertionError(f"timed out waiting for {expected!r}; last value was {last!r}")


def _expire_lease(task, attempts="[]"):
    _psql(
        f"UPDATE tasks SET status='running',waiting_reason=NULL,lease_owner='dead-worker',"
        f"lease_until=now()-interval '1 minute',lease_epoch=lease_epoch+1,attempt=greatest(attempt,1),"
        f"checkpoint=jsonb_set(checkpoint,'{{attempts}}','{attempts}'::jsonb,true) WHERE id='{task}'"
    )


def _put_transcript(task, body):
    request = urllib.request.Request(
        API + f"/internal/tasks/{task}/transcript",
        data=json.dumps(body).encode(),
        method="PUT",
        headers={"Authorization": "Bearer " + WORKER, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status
    except urllib.error.HTTPError as exc:
        return exc.code


def _worker_tool(body):
    request = urllib.request.Request(
        API + "/internal/tools/execute",
        data=json.dumps(body).encode(),
        method="POST",
        headers={"Authorization": "Bearer " + WORKER, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read())


def _compact(task, body):
    request = urllib.request.Request(
        API + f"/internal/tasks/{task}/compact",
        data=json.dumps(body).encode(),
        method="POST",
        headers={"Authorization": "Bearer " + WORKER, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read())


def test_shell_execute_deduped_by_idempotency_key():
    client, bot, _, task = _setup()
    try:
        _psql(f"UPDATE tasks SET status='running',waiting_reason=NULL,lease_owner='dedupe-test',lease_until=now()+interval '1 minute',lease_epoch=1 WHERE id='{task}'")
        path = f"/workspace/dedupe-{task}.txt"
        key = task + ":dedupe-integration"
        request = {
            "taskId": task,
            "botId": bot,
            "epoch": 1,
            "tool": "write_file",
            "args": {"path": path, "content": "first execution"},
            "idempotencyKey": key,
        }
        status, first = _worker_tool(request)
        assert status == 200 and first.get("ok") is True, first
        status, second = _worker_tool({**request, "args": {"path": path, "content": "second execution"}})
        assert status == 200 and second.get("deduped") is True, second
        assert _psql(f"SELECT count(*) FROM tool_execution_dedupe WHERE task_id='{task}' AND idempotency_key='{key}' AND status='completed'") == "1"
        assert _psql(f"SELECT count(*) FROM task_steps WHERE task_id='{task}' AND tool='write_file'") == "1"

        read_status, read_result = _worker_tool({
            "taskId": task, "botId": bot, "epoch": 1, "tool": "read_file", "args": {"path": path}
        })
        assert read_status == 200 and read_result["output"]["content"] == "first execution", read_result
    finally:
        _cleanup(client, bot, task)


def test_continue_raises_clamped_budget_and_audits_owner_action():
    client, bot, _, task = _setup()
    try:
        before_epoch = int(_psql(f"SELECT lease_epoch FROM tasks WHERE id='{task}'"))
        status, body = client.call("POST", f"/api/tasks/{task}/continue", {"extraSteps": 5000, "extraSeconds": 99999})
        assert status == 200, body
        assert body["maxSteps"] == 1000 and body["maxSeconds"] == 21600
        assert int(_psql(f"SELECT lease_epoch FROM tasks WHERE id='{task}'")) > before_epoch
        assert _psql(f"SELECT status FROM tasks WHERE id='{task}'") in {"queued", "running", "completed", "failed"}
        assert int(_psql(f"SELECT count(*) FROM audit_events WHERE task_id='{task}' AND action='task.budget_continue'")) == 1
        assert client.call("POST", f"/api/tasks/{task}/continue", {})[0] == 409
    finally:
        _cleanup(client, bot, task)


def test_next_chat_message_resumes_paused_task_and_appends_continuation():
    client, bot, conversation, task = _setup()
    try:
        status, result = client.call("POST", f"/api/conversations/{conversation}/messages", {"content": "Continue by checking the last result."})
        assert status == 200, result
        assert result["taskId"] == task and result["resumed"] is True
        row = _psql(f"SELECT status||':'||coalesce(waiting_reason,'')||':'||instruction FROM tasks WHERE id='{task}'")
        assert row.split(":", 2)[0] in {"queued", "running", "completed", "failed"}
        assert "User continuation: Continue by checking the last result." in row
        assert int(_psql(f"SELECT count(*) FROM audit_events WHERE task_id='{task}' AND action='task.resumed' AND detail->>'source'='user_message'")) == 1
    finally:
        _cleanup(client, bot, task)


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
        _cleanup(client, bot, task)


def test_expired_lease_resumes_collapses_notice_and_records_attempts():
    client, bot, _, task = _setup()
    try:
        _expire_lease(task)
        _wait_for(f"SELECT count(*) FROM task_run_events WHERE task_id='{task}' AND type='resumed' AND detail->>'reason'='lease_expired'", "1")

        # Recreate a second dead lease after the first worker claim to exercise notice collapse.
        _expire_lease(task)
        # Wait for the second worker claim and resume event.
        _wait_for(f"SELECT count(*) FROM task_run_events WHERE task_id='{task}' AND type='resumed' AND detail->>'reason'='lease_expired'", "2")

        assert _psql(f"SELECT count(*) FROM messages WHERE task_id='{task}' AND kind='text' AND content::jsonb->>'type'='resume'") == "1"
        assert int(_psql(f"SELECT count(*) FROM task_attempt_log WHERE task_id='{task}' AND end_reason='lease_expired'")) >= 2
        status, attempts = client.call("GET", f"/api/tasks/{task}/attempts")
        assert status == 200 and any((row.get("endReason") or row.get("end_reason")) == "lease_expired" for row in attempts)
        assert client.call("GET", f"/api/tasks/{uuid.uuid4()}/attempts")[0] == 404
    finally:
        _cleanup(client, bot, task)


def test_two_no_progress_expiries_pause_with_card_and_are_not_requeued():
    client, bot, _, task = _setup()
    try:
        history = json.dumps([{
            "n": 1,
            "startedAt": "2026-10-24T00:00:00Z",
            "endedAt": "2026-10-24T00:00:01Z",
            "endReason": "lease_expired",
            "stepsAtEnd": 0,
            "progress": False,
        }], separators=(",", ":"))
        _expire_lease(task, history)
        _wait_for(f"SELECT status||':'||waiting_reason FROM tasks WHERE id='{task}'", "waiting_human:no_progress")
        assert int(_psql(f"SELECT count(*) FROM task_run_events WHERE task_id='{task}' AND type='no_progress'")) == 1
        assert _psql(f"SELECT count(*) FROM messages WHERE task_id='{task}' AND content::jsonb->>'type'='resume_card' AND content::jsonb->>'reason'='no_progress' AND content::jsonb->>'state'='open'") == "1"
        time.sleep(5)
        assert _psql(f"SELECT status||':'||waiting_reason FROM tasks WHERE id='{task}'") == "waiting_human:no_progress"
    finally:
        _cleanup(client, bot, task)


def test_continue_marks_resume_card_and_emits_budget_continued():
    client, bot, _, task = _setup()
    try:
        card = json.dumps({"type": "resume_card", "reason": "budget_reached", "state": "open", "taskId": task})
        _psql(
            "INSERT INTO messages(conversation_id,role,kind,content,task_id) "
            f"VALUES ((SELECT conversation_id FROM tasks WHERE id='{task}'),'assistant','text',"
            f"'{card}','{task}')"
        )
        status, body = client.call("POST", f"/api/tasks/{task}/continue", {})
        assert status == 200, body
        assert _psql(f"SELECT content::jsonb->>'state' FROM messages WHERE task_id='{task}' AND content::jsonb->>'type'='resume_card'") == "continued"
        assert _psql(f"SELECT count(*) FROM task_run_events WHERE task_id='{task}' AND type='budget_continued'") == "1"
    finally:
        _cleanup(client, bot, task)


def test_transcript_epoch_fence_rejects_stale_and_accepts_current_epoch():
    client, bot, _, task = _setup()
    try:
        _psql(f"UPDATE tasks SET status='running',lease_epoch=7,lease_owner='test-worker',lease_until=now()+interval '1 minute' WHERE id='{task}'")
        body = {"messages": [{"role": "user", "content": "epoch fence"}]}
        assert _put_transcript(task, {**body, "epoch": 6}) == 409
        assert _put_transcript(task, {**body, "epoch": 7}) == 200
        assert _psql(f"SELECT count(*) FROM task_transcript WHERE task_id='{task}'") == "1"
    finally:
        _cleanup(client, bot, task)


def test_transcript_put_is_append_only():
    client, bot, _, task = _setup()
    try:
        _psql(f"UPDATE tasks SET status='running',lease_epoch=7,lease_owner='test-worker',lease_until=now()+interval '1 minute' WHERE id='{task}'")
        first = [{"role": "user", "content": "first"}, {"role": "assistant", "content": "second"}, {"role": "user", "content": "third"}]
        assert _put_transcript(task, {"epoch": 7, "messages": first}) == 200
        first_ids = _psql(f"SELECT string_agg(id::text,',' ORDER BY seq) FROM task_transcript WHERE task_id='{task}'")

        extended = first + [{"role": "assistant", "content": "fourth"}, {"role": "user", "content": "fifth"}]
        assert _put_transcript(task, {"epoch": 7, "messages": extended}) == 200
        extended_ids = _psql(f"SELECT string_agg(id::text,',' ORDER BY seq) FROM task_transcript WHERE task_id='{task}'")
        assert extended_ids.split(",")[:3] == first_ids.split(",")
        assert _psql(f"SELECT count(*) FROM task_transcript WHERE task_id='{task}'") == "5"

        rewritten = [{"role": "user", "content": "rewritten prefix"}, *extended[1:]]
        assert _put_transcript(task, {"epoch": 7, "messages": rewritten}) == 200
        assert _psql(f"SELECT count(*) FROM task_transcript WHERE task_id='{task}'") == "5"
        assert _psql(f"SELECT content FROM task_transcript WHERE task_id='{task}' AND seq=0") == "rewritten prefix"
    finally:
        _cleanup(client, bot, task)


def test_compaction_archives_replaced_rows_and_rewrites_transcript():
    client, bot, _, task = _setup()
    try:
        _psql(f"UPDATE tasks SET status='running',lease_epoch=7,lease_owner='compact-test',lease_until=now()+interval '1 minute' WHERE id='{task}'")
        old = [
            {"role": "system", "content": "system"},
            {"role": "user", "content": "original request"},
            {"role": "assistant", "content": "finished a file write"},
        ]
        assert _put_transcript(task, {"epoch": 7, "messages": old}) == 200
        compacted = [{"role": "system", "content": "system"}, {"role": "user", "content": "[compaction summary 1] {}"}]
        status, result = _compact(task, {"epoch": 7, "compactionId": "integration-compact", "archivedFromSeq": 0, "archivedToSeq": 2, "messages": compacted, "stats": {"stage": "summary", "estimateBefore": 120, "estimateAfter": 50}})
        assert status == 200, result
        assert _psql(f"SELECT count(*) FROM task_transcript_archive WHERE task_id='{task}' AND compaction_id='integration-compact'") == "3"
        assert _psql(f"SELECT count(*) FROM task_transcript WHERE task_id='{task}'") == "2"
        assert _psql(f"SELECT type FROM task_run_events WHERE task_id='{task}' AND type='compacted'") == "compacted"
        assert _psql(f"SELECT checkpoint->>'compactions' FROM tasks WHERE id='{task}'") == "1"
        assert _psql(f"SELECT count(*) FROM messages WHERE task_id='{task}' AND content::jsonb->>'event'='compacted'") == "1"
    finally:
        _cleanup(client, bot, task)


def test_compact_route_rejects_stale_epoch():
    client, bot, _, task = _setup()
    try:
        _psql(f"UPDATE tasks SET status='running',lease_epoch=7,lease_owner='compact-test',lease_until=now()+interval '1 minute' WHERE id='{task}'")
        status, _ = _compact(task, {"epoch": 6, "compactionId": "stale-compact", "archivedFromSeq": 0, "archivedToSeq": 0, "messages": [{"role": "user", "content": "no"}], "stats": {}})
        assert status == 409
        assert _psql(f"SELECT count(*) FROM task_transcript_archive WHERE task_id='{task}'") == "0"
    finally:
        _cleanup(client, bot, task)


def test_history_endpoint_is_owner_checked():
    client, bot, _, task = _setup()
    try:
        assert client.call("GET", f"/api/tasks/{task}/history")[0] == 200
        worker_call("POST", "/internal/test/users", {"username": "compact-history-other", "password": "compact-history-password"})
        from test_acceptance import Client
        other = Client()
        assert other.call("POST", "/api/auth/login", {"username": "compact-history-other", "password": "compact-history-password"}, auth=False)[0] == 200
        assert other.call("GET", f"/api/tasks/{task}/history")[0] == 404
    finally:
        _cleanup(client, bot, task)


def test_pause_on_budget_work_setting_persists():
    client, bot, _, task = _setup()
    try:
        status, body = client.call("PATCH", f"/api/bots/{bot}/work-settings", {"pauseOnBudget": False})
        assert status == 200, body
        status, settings = client.call("GET", f"/api/bots/{bot}/work-settings")
        assert status == 200, settings
        assert settings["pauseOnBudget"] is False
    finally:
        _cleanup(client, bot, task)


def test_expired_waiting_approval_lease_is_not_requeued():
    client, bot, _, task = _setup()
    try:
        _psql(f"UPDATE tasks SET status='waiting_approval',waiting_reason='approval',lease_owner='dead-worker',lease_until=now()-interval '1 minute' WHERE id='{task}'")
        time.sleep(5)
        assert _psql(f"SELECT status||':'||waiting_reason FROM tasks WHERE id='{task}'") == "waiting_approval:approval"
        assert _psql(f"SELECT count(*) FROM task_run_events WHERE task_id='{task}' AND type='resumed'") == "0"
    finally:
        _cleanup(client, bot, task)


def test_cancelled_task_emits_stopped_event_and_is_never_resumed():
    client, bot, _, task = _setup()
    try:
        _psql(f"UPDATE tasks SET status='running',lease_owner='dead-worker',lease_until=now()-interval '1 minute' WHERE id='{task}'")
        assert client.call("POST", f"/api/tasks/{task}/cancel")[0] == 200
        assert _psql(f"SELECT count(*) FROM task_run_events WHERE task_id='{task}' AND type='task_stopped'") == "1"
        time.sleep(5)
        assert _psql(f"SELECT status FROM tasks WHERE id='{task}'") == "cancelled"
        assert _psql(f"SELECT count(*) FROM task_run_events WHERE task_id='{task}' AND type='resumed'") == "0"
    finally:
        _cleanup(client, bot, task)
