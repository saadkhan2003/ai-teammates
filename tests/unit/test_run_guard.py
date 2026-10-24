"""Run guards stop loops before another model or browser call."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services" / "agent"))

from run_guard import RunGuard


def test_new_default_budget_is_one_hour_and_two_hundred_steps():
    guard = RunGuard()
    assert guard.max_steps == 200
    assert guard.max_seconds == 3600


def test_nudge_text_is_plain_user_instruction():
    from worker import nudge_message

    assert nudge_message() == {"role": "user", "content": "You have made no progress for N minutes. Say what is blocking you, or take the next concrete step, or call ask_user."}


def test_repeat_and_step_and_time_budgets():
    clock = {"now": 0.0}

    def now() -> float:
        return clock["now"]

    guard = RunGuard(max_steps=4, max_seconds=10, repeat_limit=3, clock=now)
    assert guard.note("browser_open", {"url": "https://a.example"}) is None
    assert guard.note("browser_open", {"url": "https://b.example"}) is None
    assert guard.note("browser_open", {"url": "https://a.example"}) is None
    assert guard.note("browser_open", {"url": "https://a.example"}) == "repeat_loop"

    steps = RunGuard(max_steps=2, max_seconds=10, repeat_limit=9, clock=now)
    assert steps.note("read_file", {"path": "a"}) is None
    assert steps.note("read_file", {"path": "b"}) is None
    assert steps.note("read_file", {"path": "c"}) == "step_budget"

    timed = RunGuard(max_steps=9, max_seconds=5, repeat_limit=9, clock=now)
    assert timed.note("shell", {"command": "true"}) is None
    clock["now"] = 6
    assert timed.note("shell", {"command": "false"}) == "time_budget"


def test_invalid_tool_stops_on_the_second_call():
    guard = RunGuard()
    assert guard.note_invalid("ask_user") is None
    assert guard.note_invalid("ask_user") == "invalid_repeat"
    other = RunGuard()
    assert other.note_invalid("ask_user") is None
    assert other.note_invalid("shell") is None


def test_ledger_seeds_cumulative_and_per_attempt_budgets():
    clock = {"now": 10.0}
    guard = RunGuard(
        max_steps=5, max_seconds=30, steps_used=4, seconds_used=20,
        max_attempt_steps=2, max_attempt_seconds=8, repeat_limit=9,
        clock=lambda: clock["now"],
    )
    assert guard.note("read_file", {"path": "a"}) is None
    assert guard.steps == 5 and guard.attempt_steps == 1
    assert guard.note("read_file", {"path": "b"}) == "step_budget"

    attempt = RunGuard(max_steps=20, max_seconds=30, max_attempt_steps=1, repeat_limit=9, clock=lambda: clock["now"])
    assert attempt.note("read_file", {"path": "a"}) is None
    assert attempt.note("read_file", {"path": "b"}) == "attempt_step_budget"

    timed = RunGuard(max_steps=20, max_seconds=30, seconds_used=25, max_attempt_seconds=8, repeat_limit=9, clock=lambda: clock["now"])
    clock["now"] = 19
    assert timed.note("read_file", {"path": "a"}) == "attempt_time_budget"


def test_preexec_gate_denies_errors_and_requires_explicit_allow():
    import asyncio
    guard = RunGuard()
    async def allow(tool, args):
        return {"decision": "allow"}
    async def malformed(tool, args):
        return {"status": "ok"}
    async def unavailable(tool, args):
        raise OSError("offline")
    assert asyncio.run(guard.preexec(allow, "shell", {"command": "true"})) == {"decision": "allow"}
    assert asyncio.run(guard.preexec(malformed, "shell", {}))["decision"] == "deny"
    assert asyncio.run(guard.preexec(unavailable, "shell", {}))["decision"] == "deny"
