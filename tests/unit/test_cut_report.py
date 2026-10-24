import importlib.util
import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REPORT_PATH = ROOT / "scripts" / "cut-report.py"
SUPERVISOR_PATH = ROOT / "scripts" / "cut-supervisor.sh"
spec = importlib.util.spec_from_file_location("cut_report", REPORT_PATH)
cut_report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cut_report)


def row(wall, calls):
    return {"wall_seconds": wall, "tool_calls": calls, "exit_reason": "cut"}


def test_report_maths_and_fixed_wall_clock_verdict():
    report = cut_report.build_report([row(3600, 10), row(3600, 20), row(3600, 30)])
    assert report["count"] == 3
    assert report["min_wall_seconds"] == 3600
    assert report["median_wall_seconds"] == 3600
    assert report["max_wall_seconds"] == 3600
    assert report["hour_signal_count"] == 3
    assert report["median_tool_calls"] == 20
    assert report["wall_seconds_cv"] == 0
    assert report["tool_calls_cv"] > 0.3
    assert report["verdict"] == "fixed wall clock"


def test_call_count_and_inconclusive_verdicts():
    report = cut_report.build_report([row(100, 20), row(200, 20), row(300, 20)])
    assert report["verdict"] == "call count"
    assert cut_report.build_report([row(10, 1)])["verdict"] == "inconclusive (need 2 more cuts)"


def run_supervisor(tmp_path, runner_body):
    prompt = tmp_path / "prompt.md"
    prompt.write_text("Original task", encoding="utf-8")
    worktree = tmp_path / "worktree"
    worktree.mkdir()
    runner = tmp_path / "runner.sh"
    runner.write_text("#!/usr/bin/env bash\nset -eu\n" + runner_body, encoding="utf-8")
    runner.chmod(0o755)
    cut_log = tmp_path / "cuts.jsonl"
    env = os.environ.copy()
    env.update({"RUNNER": str(runner), "CUT_LOG": str(cut_log), "CODEX_LOG_DIR": str(tmp_path / "runner-logs"), "MAX_RESTARTS": "5"})
    result = subprocess.run(["bash", str(SUPERVISOR_PATH), "sample", str(prompt), str(worktree)], env=env, text=True, capture_output=True, timeout=10)
    assert result.returncode == 0, result.stderr
    return [json.loads(line) for line in cut_log.read_text(encoding="utf-8").splitlines()]


def test_supervisor_records_completed_run(tmp_path):
    records = run_supervisor(tmp_path, 'printf "exec\\nEXIT 0\\n"\ntouch "$CUT_LAST_MESSAGE"\n')
    assert len(records) == 1
    record = records[0]
    assert record["exit_reason"] == "completed"
    assert record["exit_code"] == 0
    assert record["tool_calls"] == 1
    assert record["wall_seconds"] >= 0
    assert record["start_time"].endswith("+05:00")
    assert record["start_time_utc"].endswith("+00:00")


def test_supervisor_relaunches_cuts_then_completes(tmp_path):
    counter = tmp_path / "runs"
    counter_q = "'" + str(counter) + "'"
    body = (
        f"count=0\n[[ -f {counter_q} ]] && count=$(cat {counter_q})\n"
        f"count=$((count + 1))\nprintf '%s\\n' \"$count\" > {counter_q}\n"
        "echo exec\nif (( count < 3 )); then echo 'EXIT 1'; exit 1; fi\n"
        "touch \"$CUT_LAST_MESSAGE\"\necho 'EXIT 0'\n"
    )
    records = run_supervisor(tmp_path, body)
    assert [record["exit_reason"] for record in records] == ["cut", "cut", "completed"]
    assert [record["exit_code"] for record in records] == [1, 1, 0]
    assert all(record["tool_calls"] == 1 for record in records)
