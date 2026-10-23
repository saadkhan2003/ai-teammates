"""Per-run limits: repeated calls, step count, and elapsed time."""

from __future__ import annotations

import json
import time
from typing import Any, Callable

MAX_STEPS = 200
MAX_SECONDS = 3600
REPEAT_LIMIT = 3
# The second invalid call for one tool ends the run. The first is returned to the model.
INVALID_LIMIT = 2


class RunGuard:
    def __init__(
        self,
        *,
        max_steps: int = MAX_STEPS,
        max_seconds: float = MAX_SECONDS,
        repeat_limit: int = REPEAT_LIMIT,
        steps_used: int = 0,
        seconds_used: float = 0,
        max_attempt_steps: int | None = None,
        max_attempt_seconds: float | None = None,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self.max_steps = max_steps
        self.max_seconds = max_seconds
        self.repeat_limit = repeat_limit
        self._clock = clock or time.monotonic
        self.started = self._clock()
        self.steps = max(0, int(steps_used))
        self.attempt_steps = 0
        self.elapsed_before_attempt = max(0.0, float(seconds_used))
        self.max_attempt_steps = max_attempt_steps
        self.max_attempt_seconds = max_attempt_seconds
        self._seen: dict[str, int] = {}

    def note(self, tool: str, args: dict | None) -> str | None:
        self.steps += 1
        self.attempt_steps += 1
        if self.max_attempt_steps is not None and self.attempt_steps > self.max_attempt_steps:
            return "attempt_step_budget"
        if self.steps > self.max_steps:
            return "step_budget"
        if self.max_attempt_seconds is not None and self._clock() - self.started > self.max_attempt_seconds:
            return "attempt_time_budget"
        if self.elapsed_before_attempt + self._clock() - self.started > self.max_seconds:
            return "time_budget"
        payload = args if isinstance(args, dict) else {}
        signature = tool + "\n" + json.dumps(payload, sort_keys=True, default=str)[:800]
        if self._bump(signature):
            return "repeat_loop"
        if tool == "browser_open":
            url = str(payload.get("url") or "")
            if url and self._bump("url:" + url):
                return "repeat_loop"
        return None

    @property
    def elapsed_seconds(self) -> float:
        return self.elapsed_before_attempt + max(0.0, self._clock() - self.started)

    @property
    def attempt_elapsed_seconds(self) -> float:
        return max(0.0, self._clock() - self.started)

    def note_invalid(self, tool: str) -> str | None:
        if self._bump("invalid:" + (tool or "tool")):
            return "invalid_repeat"
        return None

    def _bump(self, key: str) -> bool:
        count = self._seen.get(key, 0) + 1
        self._seen[key] = count
        limit = INVALID_LIMIT if key.startswith("invalid:") else self.repeat_limit
        return count >= limit
