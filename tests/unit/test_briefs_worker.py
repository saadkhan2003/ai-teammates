"""Brief feedback remains fixable and steering is private, durable and read before planning."""
import asyncio
import json
from pathlib import Path
import sys
import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services/agent"))
from worker import Worker, SYSTEM, fold_brief_steering
from compaction import apply_summary
from guard import invalid_reason, RISKY_PREEXEC_TOOLS


def test_steering_is_redacted_deduplicated_and_survives_canonical_transcript_roundtrip():
    token = "sk-or-" + "x" * 30
    notes = [{"id": "note-1", "text": "Keep light theme " + token}]
    messages = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": "Original brief"}]
    fold_brief_steering(messages, notes)
    assert token not in messages[-1]["content"] and "[REDACTED]" in messages[-1]["content"]
    canonical = [{"role": m["role"], "content": m["content"]} for m in messages]
    fold_brief_steering(canonical, notes)
    assert len(canonical) == 3
    canonical += [{"role": "user", "content": f"later-{i}"} for i in range(40)]
    compacted = apply_summary(canonical, {"goal": "Continue"})
    assert sum("[brief-steering:note-1]" in m.get("content", "") for m in compacted) == 1
    fold_brief_steering(compacted, notes)
    assert sum("[brief-steering:note-1]" in m.get("content", "") for m in compacted) == 1


@pytest.mark.parametrize("status", ["brief_rejected", "brief_needs_rewrite", "needs_clarification"])
def test_fixable_brief_results_do_not_consume_invalid_tool_retry_budget(status):
    assert invalid_reason({"ok": False, "status": status, "issues": [{"field": "context", "message": "Quote the user."}]}) is None
    assert invalid_reason({"ok": True, "output": {"status": status}}) is None


def test_guide_is_immutable_builtin_and_prompt_explains_correction_and_clarification():
    guide = (ROOT / "services/agent/skills/builtin/writing-a-great-brief.md").read_text()
    assert guide.startswith("---\nname: writing-a-great-brief\n")
    for heading in ("UI polish", "Bugfix", "Backend feature", "Research/report"):
        assert "## " + heading in guide
    for phrase in ("brief_rejected", "brief_needs_rewrite", "needs_clarification", "ask_user", "writing-a-great-brief"):
        assert phrase in SYSTEM
    assert "spawn_child_task" in RISKY_PREEXEC_TOOLS


def test_steering_is_fetched_and_persisted_before_next_model_call():
    async def run():
        worker = Worker()
        seen = []
        async def request_json(method, path, body=None):
            seen.append(path)
            if "/brief/steering" in path:
                assert "epoch=7" in path
                return {"steering": [{"id": "s-1", "text": "Audit both themes"}]}
            if path.endswith("/complete"):
                assert any("Audit both themes" in m.get("content", "") for m in body["messages"])
                return {"status": "ok", "message": {"role": "assistant", "content": "Done"}}
            return {"catalog": []}
        async def persist(task, messages):
            seen.append("persist")
        worker.request_json = request_json
        worker._put_transcript = persist
        messages = [{"role": "system", "content": SYSTEM}]
        await worker._complete_model({"id": "child", "botId": "bot", "epoch": 7, "hasBrief": True}, messages)
        assert seen[0].endswith("/brief/steering?epoch=7")
        assert seen[1] == "persist" and seen[-1] == "/internal/model/complete"
    asyncio.run(run())


def test_mock_trigger_repairs_brief_after_server_feedback():
    import importlib.util
    spec = importlib.util.spec_from_file_location("brief_fixture_planner", ROOT / "services/mock-openrouter/planner.py")
    planner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(planner)
    messages = [{"role": "user", "content": "BRIEF_TEST"}, {"role": "tool", "name": "shell", "content": '{"ok":true}'}]
    first = planner.plan(messages)["choices"][0]["message"]["tool_calls"][0]["function"]
    assert first["name"] == "spawn_child_task" and "context" not in json.loads(first["arguments"])["brief"]
    messages.append({"role": "tool", "name": "spawn_child_task", "content": '{"status":"brief_rejected","issues":[{"field":"context","message":"Quote the user"}]}'} )
    repaired = json.loads(planner.plan(messages)["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"])["brief"]
    assert repaired["context"] and repaired["report_back"] and repaired["acceptance"][0]["check"]
