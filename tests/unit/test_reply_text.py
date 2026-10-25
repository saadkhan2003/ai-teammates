"""Raw tool output never reaches chat: the worker humanizes tool-result JSON and the mock job demos reply in prose."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services" / "agent"))
sys.path.insert(0, str(ROOT / "services" / "mock-openrouter"))

from reply_text import humanize_reply  # noqa: E402
from planner import plan  # noqa: E402

STARTED = {"ok": True, "status": "running", "job_id": "7c0d", "name": "Long demo", "max_minutes": 10.0,
           "log_path": "jobs/7c0d/log.txt", "result_dir": "jobs/7c0d/result", "note": "Runs in the background."}


def test_job_start_json_becomes_prose():
    text = "Started: " + json.dumps(STARTED)
    assert humanize_reply(text) == "Started Long demo in the background. I'll tell you when it's done."


def test_failed_tool_result_reads_as_sentence():
    out = humanize_reply('Started: {"ok": false, "status": "blocked", "code": "job_limit", "reason": "Your plan runs up to 2 background jobs at once."}')
    assert out == "That didn't work: Your plan runs up to 2 background jobs at once."
    assert "{" not in out


def test_job_status_list_and_plain_text_untouched():
    out = humanize_reply('Jobs: {"jobs": [{"name": "Tick demo", "status": "running", "job_id": "a"}, {"name": "Old", "status": "timed_out", "job_id": "b"}]}')
    assert out == "Background jobs: Tick demo is running; Old is timed out."
    plain = 'Here is a config: {"theme": "dark"} and a set {a, b}.'
    assert humanize_reply(plain) == plain
    assert humanize_reply("") == ""


def _final(prompt, tool_content):
    messages = [{"role": "user", "content": prompt}]
    first = plan(messages)["choices"][0]["message"]
    call = first["tool_calls"][0]
    messages += [first, {"role": "tool", "tool_call_id": call["id"], "content": json.dumps(tool_content)}]
    return plan(messages)["choices"][0]["message"]["content"]


def test_mock_job_demos_reply_in_prose():
    text = _final("JOB LONG DEMO", STARTED)
    assert text == "Started Long demo in the background. I'll tell you when it's done."
    assert _final("JOB DEMO 3", {**STARTED, "name": "Tick demo"}).startswith("Started Tick demo in the background")
    assert "{" not in _final("JOB STATUS DEMO", {"jobs": [{"name": "Long demo", "status": "running"}]})
    assert _final("STORAGE DEMO hi", {"ok": True, "path": "/workspace/notes/storage-demo.txt"}) == "Write result: saved /workspace/notes/storage-demo.txt."
    assert _final("STORAGE READ DEMO", {"path": "x", "content": "first\n"}) == "Read result: first"


PAUSED = {"ok": False, "status": "blocked", "code": "usage_limit",
          "reason": "You've used all of this week's included usage, so new background jobs are paused."}


def test_usage_pause_reply_does_not_repeat_the_notice():
    out = humanize_reply("Started: " + json.dumps(PAUSED))
    assert "this week's included usage" not in out and "{" not in out and "paused" in out
    text = _final("JOB DEMO 2", PAUSED)
    assert text.startswith("I couldn't start Tick demo") and "this week's included usage" not in text
