"""Explicit read-only batches. Unknown and desktop/browser tools always keep order."""
from __future__ import annotations
import asyncio
from typing import Awaitable, Callable

# Browser extraction can mutate target/session state and is deliberately excluded.
READ_ONLY_TOOLS = frozenset({
    "read_file", "git_status", "git_diff", "search_memory", "search_tools",
    "list_bots", "list_routines", "get_routine", "child_status", "thread_status",
})

def parallel_safe(calls: list[dict]) -> bool:
    return len(calls) > 1 and all(call.get("name") in READ_ONLY_TOOLS for call in calls)

async def run_calls(calls: list[dict], invoke: Callable[[dict], Awaitable[object]]) -> list:
    if parallel_safe(calls):
        # Collect every outcome before returning/raising, so no sibling invocation
        # continues after the task has advanced or changed lease/status.
        results = await asyncio.gather(*(invoke(call) for call in calls), return_exceptions=True)
        for result in results:
            if isinstance(result, BaseException):
                raise result
        return results
    return [await invoke(call) for call in calls]
