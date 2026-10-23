"""Run guards stop loops before another model or browser call."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services" / "agent"))

from run_guard import RunGuard


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
