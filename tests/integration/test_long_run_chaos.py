"""Small chaos checks for long-running tasks; requires the mock integration stack."""
from __future__ import annotations

import json
import os
import subprocess
import time
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from test_acceptance import API, OPENROUTER, _psql, login, submit
from test_bot_messaging import _bot, _workspace


def _stack_available() -> bool:
    return bool(os.environ.get("PG_CONTAINER") and os.environ.get("AGENT_CONTAINER"))


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


def _docker(*args: str) -> None:
    subprocess.run(["sudo", "docker", *args], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)


def _demo(text: str, budget: int | None = None):
    client = login()
    assert client.call("POST", "/api/secrets", {
        "namespace": "openrouter", "name": "default", "type": "API_KEY", "value": OPENROUTER,
    })[0] == 200
    bot = _bot(client, "Chaos " + uuid.uuid4().hex[:6])
    conversation = _workspace(client, bot)["conversationId"]
    if budget is not None:
        assert client.call("PATCH", f"/api/bots/{bot}/work-settings", {"maxSteps": budget, "pauseOnBudget": True})[0] == 200
    task = submit(client, conversation, text)
    return client, bot, task


def _cleanup(client, bot, task):
    _psql(f"DELETE FROM tasks WHERE id='{task}' AND bot_id='{bot}'")
    client.call("DELETE", f"/api/bots/{bot}")


def _kill_restart():
    name = os.environ.get("AGENT_CONTAINER", "resume-agent-1")
    _docker("kill", "-s", "KILL", name)
    _docker("start", name)


def _wait_steps(task: str, count: int, timeout: int = 120):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = int(_psql(f"SELECT count(*) FROM task_steps WHERE task_id='{task}'"))
        if value >= count:
            return value
        time.sleep(.2)
    raise AssertionError(f"task {task} did not reach {count} tool steps")


def _wait_monotonic_terminal(task: str, expected: str, timeout: int = 150):
    deadline = time.time() + timeout
    previous = 0
    while time.time() < deadline:
        row = _psql(f"SELECT status||':'||coalesce(checkpoint->>'stepsUsed','0') FROM tasks WHERE id='{task}'")
        status, used = row.split(":", 1)
        current = int(used)
        assert current >= previous, f"stepsUsed regressed from {previous} to {current}"
        previous = current
        if status == expected:
            return current
        time.sleep(.2)
    raise AssertionError(f"task {task} did not reach {expected}; last stepsUsed={previous}")


def test_real_docker_kill_resumes_once():
    client, bot, task = _demo("LONG RUN DEMO 30 SLOW")
    try:
        _wait_steps(task, 10)
        _kill_restart()
        _wait_monotonic_terminal(task, "completed")
        assert _psql(
            f"SELECT count(*) FROM task_run_events WHERE task_id='{task}' AND type='resumed'"
        ) == "1"
        assert int(_psql(
            f"SELECT count(*) FROM messages WHERE task_id='{task}' AND kind='text' AND (CASE WHEN left(btrim(content::text),1)='{{' THEN content::jsonb->>'type'='resume' AND content::jsonb->>'event'='resumed' ELSE false END)"
        )) <= 1
        # The kill may land mid-write: that call resumes as unknown_outcome and
        # the planner verifies with a read before repeating it. Either way every
        # step file exists exactly once and no path is written twice.
        writes = int(_psql(f"SELECT count(*) FROM task_steps WHERE task_id='{task}' AND tool='write_file'"))
        assert 29 <= writes <= 30, f"expected one write per scripted step; found {writes}"
        assert _psql(f"SELECT count(*) FROM (SELECT args->>'path' FROM task_steps WHERE task_id='{task}' AND tool='write_file' GROUP BY args->>'path' HAVING count(*)>1) duplicates") == "0"
        assert int(_psql(
            f"SELECT count(*) FROM tool_execution_dedupe WHERE task_id='{task}' AND tool='write_file' AND status='completed'"
        )) == writes
        for index in range(1, 31):
            status, content = client.call("GET", f"/api/bots/{bot}/files/raw?path=/workspace/long-run-step-{index:05d}.txt")
            assert status == 200, (index, status)
            assert str(content).startswith(f"step {index}\n"), (index, str(content)[:40])
    finally:
        _cleanup(client, bot, task)


def test_paused_stale_worker_cannot_write_after_resume():
    client, bot, task = _demo("LONG RUN DEMO 30 SLOW")
    name = os.environ.get("AGENT_CONTAINER", "resume-agent-1")
    try:
        _wait_steps(task, 2)
        before = int(_psql(f"SELECT lease_epoch FROM tasks WHERE id='{task}'"))
        _docker("pause", name)
        try:
            time.sleep(30)
            _wait_for(f"SELECT CASE WHEN status='queued' OR lease_until < now() THEN 'expired' ELSE 'active' END FROM tasks WHERE id='{task}'", "expired", 15)
        finally:
            _docker("unpause", name)
        deadline = time.time() + 240
        while time.time() < deadline:
            row = _psql(f"SELECT lease_epoch||':'||status FROM tasks WHERE id='{task}'")
            epoch, status = row.split(":", 1)
            if int(epoch) > before and status == "completed":
                break
            time.sleep(.5)
        else:
            raise AssertionError(f"task did not complete on a newer lease epoch: {row}")
        # read_file is idempotent and never claims a dedupe key; every other
        # (non-idempotent) step must map to exactly one completed claim.
        assert int(_psql(f"SELECT count(*) FROM tool_execution_dedupe WHERE task_id='{task}' AND status='completed'")) == int(_psql(f"SELECT count(*) FROM task_steps WHERE task_id='{task}' AND tool<>'read_file'"))
        assert _psql(f"SELECT count(*) FROM (SELECT args->>'path' FROM task_steps WHERE task_id='{task}' AND tool='write_file' GROUP BY args->>'path' HAVING count(*)>1) duplicates") == "0"
    finally:
        _cleanup(client, bot, task)


def test_cumulative_budget_survives_multiple_worker_kills():
    client, bot, task = _demo("LONG RUN DEMO 30 SLOW", budget=6)
    try:
        _wait_steps(task, 2)
        first = int(_psql(f"SELECT coalesce((checkpoint->>'stepsUsed')::int,0) FROM tasks WHERE id='{task}'"))
        _kill_restart()
        last = _wait_monotonic_terminal(task, "waiting_human", 240)
        assert _psql(f"SELECT waiting_reason FROM tasks WHERE id='{task}'") == "budget_reached"
        assert last <= 6 + 1
        assert last >= first > 0
        assert _psql(f"SELECT count(*) FROM task_run_events WHERE task_id='{task}' AND type='budget_reached'") == "1"
    finally:
        _cleanup(client, bot, task)


def test_poison_step_stops_after_no_progress_attempts():
    if os.environ.get("WORKER_POISON_MARKER", "") != "poison-step-marker":
        pytest.skip("requires agent environment WORKER_POISON_MARKER=poison-step-marker")
    client, bot, task = _demo("POISON STEP DEMO")
    try:
        _wait_for(f"SELECT status||':'||waiting_reason FROM tasks WHERE id='{task}'", "waiting_human:no_progress", 240)
        assert _psql(f"SELECT count(*) FROM task_run_events WHERE task_id='{task}' AND type='no_progress'") == "1"
        before = _psql(f"SELECT count(*) FROM task_run_events WHERE task_id='{task}' AND type='resumed'")
        time.sleep(10)
        assert _psql(f"SELECT count(*) FROM task_run_events WHERE task_id='{task}' AND type='resumed'") == before
    finally:
        _cleanup(client, bot, task)


def test_auto_resume_ceiling_is_enforced():
    client, bot, task = _demo("LONG RUN DEMO 30 SLOW")
    name = os.environ.get("AGENT_CONTAINER", "resume-agent-1")
    try:
        _wait_steps(task, 2)
        # Freeze the worker so its heartbeat cannot renew the lease or rewrite
        # the checkpoint, then seed the durable attempt ledger with five
        # automatic resumes inside the rolling hour and expire the lease to
        # exercise the real sweeper ceiling.
        _docker("pause", name)
        try:
            now = datetime.now(timezone.utc)
            attempts = json.dumps([
                {"n": n, "startedAt": (now - timedelta(minutes=30 - n * 5)).isoformat(),
                 "endedAt": (now - timedelta(minutes=29 - n * 5)).isoformat(),
                 "endReason": "lease_expired", "progress": True}
                for n in range(1, 6)
            ])
            _psql(f"UPDATE tasks SET checkpoint=jsonb_set(coalesce(checkpoint,'{{}}'::jsonb),'{{attempts}}','{attempts}'::jsonb,true),lease_until=now()-interval '1 minute' WHERE id='{task}'")
            _wait_for(f"SELECT status||':'||waiting_reason FROM tasks WHERE id='{task}'", "waiting_human:resume_exhausted", 90)
        finally:
            _docker("unpause", name)
        assert _psql(f"SELECT count(*) FROM task_run_events WHERE task_id='{task}' AND type='resume_exhausted'") == "1"
        time.sleep(5)
        assert _psql(f"SELECT status||':'||waiting_reason FROM tasks WHERE id='{task}'") == "waiting_human:resume_exhausted"
    finally:
        _cleanup(client, bot, task)


def test_shell_append_unknown_outcome_is_verified_after_resume():
    client, bot, task = _demo("SHELL APPEND DEMO")
    try:
        _wait_for(f"SELECT count(*) FROM task_steps WHERE task_id='{task}' AND tool='shell'", "1", 90)
        _kill_restart()
        _wait_for(f"SELECT status FROM tasks WHERE id='{task}'", "completed", 120)
        unknown = _psql(f"SELECT count(*) FROM task_transcript WHERE task_id='{task}' AND content::text ILIKE '%unknown_outcome%'")
        if int(unknown) >= 1:
            assert _psql(f"SELECT count(*) FROM task_steps WHERE task_id='{task}' AND tool='shell'") == "1"
        else:
            status, content = client.call("GET", f"/api/bots/{bot}/files/raw?path=/workspace/shell-append-demo.log")
            assert status == 200
            assert content == "x\n"
    finally:
        _cleanup(client, bot, task)
