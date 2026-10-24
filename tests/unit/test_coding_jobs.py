import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services" / "agent"))

from coding_jobs import coding_job_body, normalize_status


def test_coding_job_body_normalizes_status_and_pr():
    body = coding_job_body(
        "bot",
        "task",
        {"title": "UI batch", "status": "tests", "step": "Running test suites", "pr_number": "4", "job_id": "abc"},
    )
    assert body["status"] == "tests"
    assert body["step"] == "Running test suites"
    assert body["prNumber"] == 4
    assert body["jobId"] == "abc"
    diff = coding_job_body("bot", "task", {"title": "Ship", "status": "merged", "branch": "cursor/bot-app-awareness", "files_changed": "31", "additions": 1113, "deletions": "26"})
    assert diff["branch"] == "cursor/bot-app-awareness"
    assert diff["filesChanged"] == 31
    assert diff["additions"] == 1113
    assert diff["deletions"] == 26
    assert normalize_status("nope") == "running"
    assert normalize_status("merged") == "merged"
