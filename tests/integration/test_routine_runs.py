"""Routine run lifecycle on the mock stack: history, overlap skip, quiet rule, auto-pause, missed window, one-off reminders."""
import datetime as dt
import time
import uuid

from test_acceptance import OPENROUTER, _psql, login, worker_call
from test_bot_messaging import _bot, _cleanup, _until, _workspace


def _setup():
    client = login()
    assert client.call("POST", "/api/secrets", {"namespace": "openrouter", "name": "default", "type": "API_KEY", "value": OPENROUTER})[0] == 200
    return client, _bot(client, "Runs" + uuid.uuid4().hex[:5])


def _routine(client, bot, name="Check", **fields):
    payload = {"name": name, "cron": "0 8 * * *", "instruction": "Say hi."}
    payload.update(fields)
    status, body = client.call("POST", f"/api/bots/{bot}/routines", payload)
    assert status == 200, body
    return body["id"]


def _get(client, rid):
    status, body = client.call("GET", f"/api/routines/{rid}")
    assert status == 200, body
    return body


def _due(client, rid, seconds_ago=1):
    when = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=seconds_ago)).isoformat()
    assert client.call("PATCH", f"/api/routines/{rid}", {"nextRunAt": when})[0] == 200


def _manual_task(bot, rid):
    conversation = _psql(f"SELECT id FROM conversations WHERE bot_id='{bot}' ORDER BY created_at LIMIT 1")
    out = _psql(
        "INSERT INTO tasks (bot_id, conversation_id, title, instruction, kind, routine_id, status, lease_owner, lease_until, lease_epoch) "
        f"VALUES ('{bot}','{conversation}','Manual','manual','work','{rid}','running','test', now() + interval '1 hour', 1) RETURNING id"
    )
    task = out.splitlines()[0]
    _psql(f"INSERT INTO routine_runs (routine_id, task_id, status) VALUES ('{rid}','{task}','running')")
    return task, conversation


def _finish(task, ok, text="done"):
    if ok:
        return worker_call("POST", f"/internal/tasks/{task}/complete", {"text": text, "epoch": 1})
    return worker_call("POST", f"/internal/tasks/{task}/fail", {"error": "boom", "epoch": 1})


def _messages(client, bot):
    return _workspace(client, bot)["messages"]


def test_due_routine_runs_with_framing_and_a_history_row():
    client, bot = _setup()
    try:
        rid = _routine(client, bot, instruction="Say hi.", quietRule="Nothing new since last time")
        _due(client, rid)
        done = _until(lambda: next((r for r in _get(client, rid)["runs"] if r["status"] == "completed"), None), timeout=90, what="completed run")
        assert done["summary"] and done["scheduledFor"] and done["taskId"]
        instruction = _psql(f"SELECT instruction FROM tasks WHERE id='{done['taskId']}'")
        assert instruction.startswith("This is a scheduled run, not a user message.")
        assert "Quiet rule: Nothing new since last time" in instruction and "NOTHING_NEW" in instruction
        routine = _get(client, rid)
        assert routine["enabled"] is True and routine["nextRunAt"] > dt.datetime.now(dt.timezone.utc).isoformat()
    finally:
        _cleanup(client, bot)


def test_overlap_is_skipped_and_history_keeps_twenty():
    client, bot = _setup()
    try:
        rid = _routine(client, bot)
        _manual_task(bot, rid)
        _psql(
            "INSERT INTO routine_runs (routine_id, status, triggered_at, finished_at) "
            f"SELECT '{rid}', 'completed', now() - (g || ' hours')::interval, now() FROM generate_series(1, 25) g"
        )
        _due(client, rid)
        run = _until(lambda: next((r for r in _get(client, rid)["runs"] if r["status"] == "skipped"), None), timeout=30, what="skipped run")
        assert run["skipReason"] == "previous_run_active"
        assert int(_psql(f"SELECT count(*) FROM routine_runs WHERE routine_id='{rid}'")) == 20
    finally:
        _cleanup(client, bot)


def test_quiet_reply_is_not_posted_and_a_real_reply_is():
    client, bot = _setup()
    try:
        rid = _routine(client, bot, quietRule="Only speak when something changed")
        task, _ = _manual_task(bot, rid)
        assert _finish(task, True, "NOTHING_NEW")["ok"]
        run = next(r for r in _get(client, rid)["runs"] if r["taskId"] == task)
        assert run["status"] == "completed" and run["notified"] is False
        assert not any(m.get("taskId") == task or m.get("task_id") == task for m in _messages(client, bot))
        loud, _ = _manual_task(bot, rid)
        assert _finish(loud, True, "Three new orders arrived.")["ok"]
        assert any("Three new orders" in str(m.get("content")) for m in _messages(client, bot))
        assert next(r for r in _get(client, rid)["runs"] if r["taskId"] == loud)["notified"] is True
    finally:
        _cleanup(client, bot)


def test_three_failures_pause_the_routine_and_say_so_in_chat():
    client, bot = _setup()
    try:
        rid = _routine(client, bot, name="Flaky")
        for _ in range(3):
            task, _ = _manual_task(bot, rid)
            _finish(task, False)
        routine = _get(client, rid)
        assert routine["enabled"] is False and routine["pausedReason"] == "failed_repeatedly" and routine["failureStreak"] == 3
        assert any("paused the routine" in str(m.get("content")) and "Flaky" in str(m.get("content")) for m in _messages(client, bot))
        assert sum(1 for r in routine["runs"] if r["status"] == "failed") == 3
        assert client.call("PATCH", f"/api/routines/{rid}", {"enabled": True})[0] == 200
        assert _get(client, rid)["failureStreak"] == 0
    finally:
        _cleanup(client, bot)


def test_success_resets_the_failure_streak():
    client, bot = _setup()
    try:
        rid = _routine(client, bot)
        for ok in (False, False, True, False, False):
            task, _ = _manual_task(bot, rid)
            _finish(task, ok)
        routine = _get(client, rid)
        assert routine["enabled"] is True and routine["failureStreak"] == 2
    finally:
        _cleanup(client, bot)


def test_run_missed_by_more_than_six_hours_is_skipped_not_fired_late():
    client, bot = _setup()
    try:
        rid = _routine(client, bot)
        _psql(f"UPDATE routines SET nominal_next_at=now() - interval '7 hours', next_run_at=now() - interval '7 hours' WHERE id='{rid}'")
        run = _until(lambda: next((r for r in _get(client, rid)["runs"] if r["status"] == "skipped"), None), timeout=30, what="skipped run")
        assert run["skipReason"] == "missed_window" and run["taskId"] is None
        assert _get(client, rid)["nextRunAt"] > dt.datetime.now(dt.timezone.utc).isoformat()
    finally:
        _cleanup(client, bot)


def test_late_by_two_hours_still_runs_once():
    client, bot = _setup()
    try:
        rid = _routine(client, bot)
        _psql(f"UPDATE routines SET nominal_next_at=now() - interval '2 hours', next_run_at=now() - interval '2 hours' WHERE id='{rid}'")
        run = _until(lambda: next((r for r in _get(client, rid)["runs"] if r["taskId"]), None), timeout=30, what="catch-up run")
        time.sleep(5)
        assert len([r for r in _get(client, rid)["runs"] if r["taskId"]]) == 1
        assert run["scheduledFor"]
    finally:
        _cleanup(client, bot)


def test_one_off_reminder_runs_once_then_finishes():
    client, bot = _setup()
    try:
        when = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=45)).isoformat()
        rid = _routine(client, bot, name="Stretch", cron=None, runAt=when)
        _psql(f"UPDATE routines SET run_at=now() - interval '1 minute', nominal_next_at=now() - interval '1 minute', next_run_at=now() - interval '1 minute' WHERE id='{rid}'")
        _until(lambda: next((r for r in _get(client, rid)["runs"] if r["taskId"]), None), timeout=30, what="reminder run")
        routine = _get(client, rid)
        assert routine["kind"] == "once" and routine["enabled"] is False and routine["pausedReason"] == "ran" and routine["nextRunAt"] is None
        assert client.call("PATCH", f"/api/routines/{rid}", {"enabled": True})[0] == 400
    finally:
        _cleanup(client, bot)
