"""Keep raw tool output out of chat replies.

A model (or the mock planner) sometimes pastes a tool result such as
{"ok": true, "status": "running", "job_id": ...} into its final answer. The chat
shows the final answer verbatim, so any embedded tool-result object is replaced
with one plain sentence before the reply is stored.
"""
from __future__ import annotations

import json
import re
from typing import Any

_TOOL_KEYS = {"ok", "status", "job_id", "jobs", "reason", "note", "log_path", "result_dir", "exit_code", "stdout", "stderr"}


def _summary(obj: dict[str, Any]) -> str:
    name = str(obj.get("name") or "the job").strip() or "the job"
    if isinstance(obj.get("jobs"), list):
        jobs = [j for j in obj["jobs"] if isinstance(j, dict)]
        if not jobs:
            return "No background jobs right now."
        parts = [f"{j.get('name') or 'job'} is {str(j.get('status') or 'unknown').replace('_', ' ')}" for j in jobs[:5]]
        more = f" and {len(jobs) - 5} more" if len(jobs) > 5 else ""
        return "Background jobs: " + "; ".join(parts) + more + "."
    if obj.get("ok") is False:
        reason = str(obj.get("reason") or "it did not work").strip().rstrip(".")
        return f"That didn't work: {reason}."
    status = str(obj.get("status") or "")
    if "job_id" in obj and status == "running":
        return f"Started {name} in the background. I'll tell you when it's done."
    if "job_id" in obj and status:
        return f"{name[0].upper() + name[1:]} is {status.replace('_', ' ')}."
    if obj.get("ok") is True:
        return "Done."
    return ""


def _looks_like_tool_result(obj: Any) -> bool:
    if not isinstance(obj, dict):
        return False
    if isinstance(obj.get("jobs"), list):
        return True
    return len(_TOOL_KEYS.intersection(obj)) >= 2 and ("ok" in obj or "job_id" in obj)


def humanize_reply(text: str) -> str:
    """Replace every embedded tool-result JSON object with a short sentence."""
    if not text or "{" not in text:
        return text
    decoder = json.JSONDecoder()
    out: list[str] = []
    i = 0
    changed = False
    while i < len(text):
        start = text.find("{", i)
        if start < 0:
            out.append(text[i:])
            break
        out.append(text[i:start])
        try:
            obj, end = decoder.raw_decode(text, start)
        except ValueError:
            out.append("{")
            i = start + 1
            continue
        if _looks_like_tool_result(obj):
            out.append(_summary(obj))
            changed = True
        else:
            out.append(text[start:end])
        i = end
    if not changed:
        return text
    result = "".join(out)
    # "Started: Started X ..." / "Jobs: Background jobs: ..." -> drop the dangling label.
    result = re.sub(r"^\s*[\w ]{1,40}:\s+(?=(Started |Background jobs|No background jobs|That didn't work|Done\.))", "", result)
    return re.sub(r"[ \t]{2,}", " ", result).strip() or "Done."
