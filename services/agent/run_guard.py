"""Per-run limits: repeated calls, step count, and elapsed time."""

from __future__ import annotations

import json
import time
from typing import Any, Callable

MAX_STEPS = 24
MAX_SECONDS = 90
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
        clock: Callable[[], float] | None = None,
    ) -> None:
        self.max_steps = max_steps
        self.max_seconds = max_seconds
        self.repeat_limit = repeat_limit
        self._clock = clock or time.monotonic
        self.started = self._clock()
        self.steps = 0
        self._seen: dict[str, int] = {}

    def note(self, tool: str, args: dict | None) -> str | None:
        self.steps += 1
        if self.steps > self.max_steps:
            return "step_budget"
        if self._clock() - self.started > self.max_seconds:
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

    def note_invalid(self, tool: str) -> str | None:
        if self._bump("invalid:" + (tool or "tool")):
            return "invalid_repeat"
        return None

    def _bump(self, key: str) -> bool:
        count = self._seen.get(key, 0) + 1
        self._seen[key] = count
        limit = INVALID_LIMIT if key.startswith("invalid:") else self.repeat_limit
        return count >= limit
