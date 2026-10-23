"""Small chaos checks for long-running tasks; requires the mock integration stack."""
from __future__ import annotations

import os
import time
import uuid

import pytest

from test_acceptance import API, OPENROUTER, _psql, login, submit
from test_bot_messaging import _bot, _workspace


def _stack_available() -> bool:
    # Integration tests use the same PG_CONTAINER convention as test_long_run_resume.
    return bool(os.environ.get("PG_CONTAINER"))


pytestmark = pytest.mark.skipif(not _stack_available(), reason="integration stack is not configured (PG_CONTAINER is missing)")


def _wait_for(sql: str, expected: str, timeout: int = 90) -> str:
    deadline = time.time() + timeout
    latest = ""
    while time.time() < deadline:
        latest = _psql(sql)
        if latest == expected:
            return latest
        time.sleep(0.5)
    raise AssertionError(f"timed out waiting for {expected!r}; last value was {latest!r}")


def test_forced_worker_exit_resumes_scripted_long_run_once():
    threshold = int(os.environ.get("WORKER_FORCED_EXIT_AFTER_STEPS", "0") or 0)
    once_file = os.environ.get("WORKER_FORCED_EXIT_ONCE_FILE", "")
    if threshold < 1 or not once_file:
        pytest.skip("worker forced-exit hook is not enabled in the agent container")
    if threshold >= 30:
        pytest.skip("forced-exit threshold must be below the 30-step demo task size")

    client = login()
    assert client.call("POST", "/api/secrets", {
        "namespace": "openrouter", "name": "default", "type": "API_KEY", "value": OPENROUTER,
    })[0] == 200
    bot = _bot(client, "Chaos " + uuid.uuid4().hex[:6])
    task = None
    try:
        conversation = _workspace(client, bot)["conversationId"]
        task = submit(client, conversation, "LONG RUN DEMO 30")
        _wait_for(f"SELECT status FROM tasks WHERE id='{task}'", "completed")
        assert _psql(
            f"SELECT count(*) FROM task_run_events WHERE task_id='{task}' AND type='resumed'"
        ) == "1"
        assert int(_psql(
            f"SELECT count(*) FROM messages WHERE task_id='{task}' AND kind='text' AND content::jsonb->>'type'='resume'"
        )) <= 1
        writes = int(_psql(f"SELECT count(*) FROM task_steps WHERE task_id='{task}' AND tool='write_file'"))
        assert writes == 30, f"expected one write per scripted step; found {writes}"
        assert int(_psql(
            f"SELECT count(*) FROM tool_execution_dedupe WHERE task_id='{task}' AND tool='write_file' AND status='completed'"
        )) == 30
        assert int(_psql(f"SELECT coalesce(checkpoint->>'stepsUsed','0') FROM tasks WHERE id='{task}'")) >= threshold
    finally:
        if task:
            _psql(f"DELETE FROM tasks WHERE id='{task}' AND bot_id='{bot}'")
        client.call("DELETE", f"/api/bots/{bot}")


@pytest.mark.skip(reason="Requires SIGSTOP/docker pause control over the first worker; unavailable in this sandbox. Existing resume tests cover API epoch fencing directly.")
def test_paused_stale_worker_cannot_write_after_resume():
    pass


@pytest.mark.skip(reason="Requires per-task low cumulative budget and repeated worker kills; no stack-level task budget injection is exposed by the mock planner.")
def test_cumulative_budget_survives_multiple_worker_kills():
    pass


@pytest.mark.skip(reason="The mock planner has no always-crashing poison tool step; adding one would require a planner extension outside this chunk's allowed area.")
def test_poison_step_stops_after_no_progress_attempts():
    pass


@pytest.mark.skip(reason="Requires six controlled worker kills within an hour; the configured one-shot hook cannot exercise the hourly ceiling repeatedly.")
def test_auto_resume_ceiling_is_enforced():
    pass


@pytest.mark.skip(reason="The mock planner has no shell append task or kill-between-execution-and-result-post control; unknown-outcome behavior cannot be honestly driven here.")
def test_shell_append_unknown_outcome_is_verified_after_resume():
    pass
