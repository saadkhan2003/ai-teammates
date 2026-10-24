"""Transcript helpers for resuming interrupted tool calls."""
from __future__ import annotations

import json
from typing import Any

from guard import scrub

NON_IDEMPOTENT = {
    "shell", "setup_env", "write_file", "edit_file", "delete_file", "git_commit", "job_start", "job_cancel",
    "create_pr", "run_tests", "spawn_child_task", "computer_click", "computer_type",
    "computer_key", "browser_click", "record_start", "record_stop",
}

UNKNOWN_OUTCOME = (
    "The worker was interrupted while this call ran. It may have partly or fully run. "
    "Check state (git status, file contents, command output) before repeating it."
)


def apply_resume(messages: list, resume: Any, attempt: Any) -> tuple[list, list[str]]:
    if not resume:
        return messages, []

    try:
        attempt_number = int(attempt if attempt is not None else 1)
    except (TypeError, ValueError):
        attempt_number = 1
    marker = f"[resume-brief attempt {attempt_number}]"
    if any(
        isinstance(message, dict)
        and isinstance(message.get("content"), str)
        and message["content"].startswith(marker)
        for message in messages
    ):
        return messages, []

    unknown_summaries: list[str] = []
    if isinstance(resume, dict) and resume.get("interrupted") is True:
        from worker import _unanswered_calls

        for call in _unanswered_calls(messages):
            name = str(call.get("name") or "")
            if name not in NON_IDEMPOTENT:
                continue
            call_id = str(call.get("id") or "")
            result = {
                "ok": False,
                "status": "unknown_outcome",
                "note": UNKNOWN_OUTCOME,
            }
            messages.append({
                "role": "tool",
                "name": name,
                "toolCallId": call_id,
                "tool_call_id": call_id,
                "content": json.dumps(scrub(result)),
            })
            args = json.dumps(scrub(call.get("arguments") or {}), sort_keys=True, separators=(",", ":"))
            args = args.replace("\n", " ")[:80]
            unknown_summaries.append(f"{name} {args}".rstrip())

    brief = marker
    if isinstance(resume, dict):
        brief_value = scrub(str(resume.get("brief") or ""))
        brief += "\n" + brief_value
    if unknown_summaries:
        brief += "\nCalls with unknown outcome: " + "; ".join(unknown_summaries)
    brief_message = {"role": "user", "resume_brief": True, "content": brief}
    if isinstance(resume, dict) and resume.get("interrupted") is True:
        from worker import _unanswered_calls

        if _unanswered_calls(messages):
            assistant_index = next(
                (
                    index
                    for index in range(len(messages) - 1, -1, -1)
                    if isinstance(messages[index], dict)
                    and messages[index].get("role") == "assistant"
                    and messages[index].get("toolCalls")
                ),
                None,
            )
            if assistant_index is not None:
                messages.insert(assistant_index, brief_message)
                return messages, unknown_summaries
    messages.append(brief_message)
    return messages, unknown_summaries
