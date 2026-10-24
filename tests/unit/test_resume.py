"""Resume briefs fence unanswered non-idempotent calls."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services" / "agent"))

from resume import apply_resume
from worker import _note_target, _unanswered_calls


def _assistant_call(name, args, call_id="call-1"):
    return {
        "role": "assistant",
        "toolCalls": [{"id": call_id, "function": {"name": name, "arguments": args}}],
    }


def test_interrupted_shell_call_gets_unknown_result_and_brief_summary():
    messages = [_assistant_call("shell", {"command": "git status"})]

    messages, summaries = apply_resume(messages, {"brief": "Continue the task.", "interrupted": True}, 2)

    result = messages[1]
    assert result["role"] == "tool"
    assert result["tool_call_id"] == "call-1"
    assert json.loads(result["content"]) == {
        "ok": False,
        "status": "unknown_outcome",
        "note": "The worker was interrupted while this call ran. It may have partly or fully run. Check state (git status, file contents, command output) before repeating it.",
    }
    assert summaries == ['shell {"command":"git status"}']
    assert messages[2]["role"] == "user"
    assert messages[2]["resume_brief"] is True
    assert "[resume-brief attempt 2]\nContinue the task." in messages[2]["content"]
    assert "Calls with unknown outcome: shell" in messages[2]["content"]


def test_read_file_call_is_left_unanswered():
    messages = [_assistant_call("read_file", {"path": "notes.txt"})]

    messages, summaries = apply_resume(messages, {"brief": "Continue.", "interrupted": True}, 2)

    assert len(messages) == 2
    assert messages[0]["role"] == "user"
    assert messages[0]["resume_brief"] is True
    assert messages[1]["role"] == "assistant"
    assert summaries == []
    assert _unanswered_calls(messages)[0]["name"] == "read_file"


def test_mixed_non_idempotent_and_read_only_calls_keep_valid_order():
    messages = [{
        "role": "assistant",
        "toolCalls": [
            {"id": "call-shell", "function": {"name": "shell", "arguments": {"command": "date"}}},
            {"id": "call-read", "function": {"name": "read_file", "arguments": {"path": "notes.txt"}}},
        ],
    }]

    messages, summaries = apply_resume(messages, {"brief": "Continue.", "interrupted": True}, 2)

    assert messages[0]["role"] == "user"
    assert messages[0]["resume_brief"] is True
    assert messages[1]["role"] == "assistant"
    assert messages[2]["role"] == "tool"
    assert messages[2]["tool_call_id"] == "call-shell"
    assert json.loads(messages[2]["content"])["status"] == "unknown_outcome"
    assert _unanswered_calls(messages)[0]["name"] == "read_file"
    assert summaries == ['shell {"command":"date"}']


def test_second_application_for_same_attempt_is_noop():
    messages = [_assistant_call("shell", {"command": "true"})]
    messages, summaries = apply_resume(messages, {"brief": "Continue.", "interrupted": True}, 2)
    original = list(messages)

    repeated, repeated_summaries = apply_resume(messages, {"brief": "Changed brief", "interrupted": True}, 2)

    assert repeated is messages
    assert repeated == original
    assert repeated_summaries == []


def test_attempt_limit_adds_brief_but_does_not_close_unanswered_call():
    messages = [_assistant_call("shell", {"command": "printf ok"})]

    messages, summaries = apply_resume(messages, {"brief": "Budget handoff.", "interrupted": False}, 3)

    assert len(messages) == 2
    assert messages[0]["role"] == "assistant"
    assert messages[1]["content"] == "[resume-brief attempt 3]\nBudget handoff."
    assert summaries == []
    assert _unanswered_calls(messages)[0]["name"] == "shell"


def test_no_resume_leaves_messages_unchanged():
    messages = [_assistant_call("shell", {"command": "true"})]

    result, summaries = apply_resume(messages, None, 2)

    assert result is messages
    assert len(messages) == 1
    assert summaries == []


def test_secret_values_in_call_args_are_scrubbed():
    messages = [_assistant_call("shell", {"command": "export TOKEN=sk-or-abcdefghijklmnopqrstuvwxyz123456"})]

    messages, summaries = apply_resume(messages, {"brief": "Continue.", "interrupted": True}, 2)

    assert "sk-or-" not in " ".join(summaries)
    assert "[REDACTED]" in " ".join(summaries)


def test_resume_brief_is_skipped_when_finding_last_tool_target():
    task = {}
    messages = [
        {"role": "tool", "content": json.dumps({"targetId": "real-target"})},
        {"role": "user", "resume_brief": True, "content": json.dumps({"targetId": "brief-target"})},
    ]

    _note_target(task, messages)

    assert task["_targetId"] == "real-target"
