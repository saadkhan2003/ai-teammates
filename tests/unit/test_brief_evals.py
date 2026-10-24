"""CI grades checked-in output from the actual C# deterministic renderer; C# verifies parity."""
import importlib.util
import json
from pathlib import Path
import pytest

ROOT = Path(__file__).resolve().parents[2]
EVAL = ROOT / "evals/briefs"
spec = importlib.util.spec_from_file_location("brief_judge", EVAL / "judge.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
CASES = [json.loads(line) for line in (EVAL / "golden.jsonl").read_text().splitlines()]


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["id"])
def test_mock_judge_golden_renderer_output(case):
    markdown = (EVAL / "rendered" / (case["id"] + ".md")).read_text()
    result = module.mock_judge(case["ask"], markdown, case["expected"])
    assert set(result["scores"]) == set(module.DIMENSIONS)
    assert all(0 <= score <= 1 for score in result["scores"].values())
    assert result["behavior"] == case["expected"]["behavior"]
    assert result["passed"] == (case["expected"]["behavior"] == "accept")
    assert result["reason"] and "\n" not in result["reason"]


def test_single_call_judge_and_schema_fail_closed():
    seen = []
    def complete(prompt):
        seen.append(prompt)
        return json.dumps({"scores": {key: .9 for key in module.DIMENSIONS}, "passed": True, "reason": "Concrete and checkable"})
    assert module.judge("A user ask", "## Goal\nAn outcome", complete)["passed"]
    assert len(seen) == 1
    with pytest.raises(ValueError):
        module.normalize_judgment({"scores": {}, "passed": True})
    with pytest.raises(ValueError):
        module.normalize_judgment({"scores": {key: 1.1 for key in module.DIMENSIONS}, "passed": True})


def test_paid_runner_reserves_before_every_call_and_checks_usage_after_errors(monkeypatch):
    monkeypatch.syspath_prepend(str(EVAL))
    spec = importlib.util.spec_from_file_location("brief_real_runner", EVAL / "run_real.py")
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    calls = []
    for cap, input_rate, output_rate in ((.05, float("nan"), 1), (.06, 1, 1), (.05, 0, 1)):
        with pytest.raises(ValueError): runner.CappedModel("unused-fixture", "fixture", cap, input_rate, output_rate)
    def request(self, path, payload=None):
        calls.append(path)
        if path == "/key":
            return {"data": {"usage": 0}}
        assert payload["max_tokens"] == 1200
        assert payload["provider"]["max_price"]["prompt"] == 1
        return {"choices": [{"message": {"content": "{}"}}]}
    monkeypatch.setattr(runner.CappedModel, "request", request)
    model = runner.CappedModel("unused-fixture", "fixture", .005, 1, 1)
    assert model.complete("short") == "{}"
    assert calls == ["/key", "/key", "/chat/completions", "/key"]
    with pytest.raises(runner.SpendLimit):
        model.complete("a" * 10000)
    assert calls[-1] == "/key" and calls.count("/chat/completions") == 1
    def failing(self, path, payload=None):
        calls.append(path)
        if path == "/key": return {"data": {"usage": 0}}
        raise OSError("provider unavailable")
    monkeypatch.setattr(runner.CappedModel, "request", failing)
    model = runner.CappedModel("unused-fixture", "fixture", .05, 1, 1)
    with pytest.raises(OSError): model.complete("short")
    assert calls[-1] == "/key"
