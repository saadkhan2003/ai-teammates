"""Coding-job status events the worker sends to the API."""
from __future__ import annotations

STATUSES = ("queued", "running", "tests", "finished", "merged", "failed")


def normalize_status(value: object) -> str:
    text = str(value or "").strip().lower()
    return text if text in STATUSES else "running"


def coding_job_body(bot_id: str, task_id: str, args: dict | None) -> dict:
    source = args if isinstance(args, dict) else {}
    title = str(source.get("title") or "Coding job").strip()[:200] or "Coding job"
    step = str(source.get("step") or "").strip()[:160]
    pr_raw = source.get("pr_number", source.get("prNumber"))
    pr_number = None
    if isinstance(pr_raw, int):
        pr_number = pr_raw
    elif isinstance(pr_raw, str) and pr_raw.strip().isdigit():
        pr_number = int(pr_raw.strip())
    pr_url = str(source.get("pr_url") or source.get("prUrl") or "").strip()[:500]
    branch = str(source.get("branch") or "").strip()[:200]
    job_id = str(source.get("job_id") or source.get("jobId") or source.get("id") or "").strip()
    body = {
        "botId": bot_id,
        "taskId": task_id,
        "title": title,
        "status": normalize_status(source.get("status")),
        "step": step,
        "prUrl": pr_url,
        "branch": branch,
    }
    if pr_number is not None:
        body["prNumber"] = pr_number
    for key, aliases in (
        ("filesChanged", ("files_changed", "filesChanged")),
        ("additions", ("additions",)),
        ("deletions", ("deletions",)),
    ):
        count = _count(source, *aliases)
        if count is not None:
            body[key] = count
    if job_id:
        body["jobId"] = job_id
    return body


def _count(source: dict, *keys: str) -> int | None:
    for key in keys:
        raw = source.get(key)
        if isinstance(raw, bool):
            continue
        if isinstance(raw, int) and raw >= 0:
            return raw
        if isinstance(raw, str) and raw.strip().isdigit():
            return int(raw.strip())
    return None
