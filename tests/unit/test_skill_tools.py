"""Guide tools use the full gated task execution path; prompts contain only catalogs."""
import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services" / "agent"))
from worker import Worker


@pytest.mark.parametrize("tool,args,output", [
    ("load_skill", {"name": "research"}, {"name": "research", "body": "# Research", "version": 3}),
    ("write_skill", {"name": "daily-review", "title": "Daily review", "when_to_use": "When reviewing work", "body": "# Review"}, {"id": "skill-1", "version": 1}),
    ("read_skill_file", {"name": "research", "path": "sources.txt"}, {"name": "research", "path": "sources.txt", "content": "sources"}),
    ("save_skill", {"name": "daily-review", "description": "When reviewing work", "body": "# Review"}, {"id": "skill-1", "version": 1}),
    ("delete_skill", {"name": "daily-review"}, {"deleted": True, "name": "daily-review"}),
])
def test_skill_tools_use_preexec_then_fenced_execute(tool, args, output):
    async def run():
        worker = Worker()
        seen = []

        async def request_json(method, path, body=None):
            seen.append((method, path, body))
            if path.endswith("/preexec"):
                return {"decision": "allow"}
            return {"ok": True, "output": output}

        worker.request_json = request_json
        result = await worker._invoke({"botId": "bot-1", "id": "task-1", "epoch": 7}, {"name": tool, "arguments": args}, authorize=True)
        assert [entry[:2] for entry in seen] == [("POST", "/internal/tools/preexec"), ("POST", "/internal/tools/execute")]
        for _, _, body in seen:
            assert body["taskId"] == "task-1" and body["botId"] == "bot-1"
            assert body["epoch"] == 7 and body["tool"] == tool and body["args"] == args
        assert seen[1][2]["idempotencyKey"]
        assert result == {"ok": True, "output": output}

    asyncio.run(run())


@pytest.mark.parametrize("tool", ["load_skill", "write_skill", "read_skill_file", "save_skill", "delete_skill"])
@pytest.mark.parametrize("decision", ["deny", "ask", "malformed", "unavailable"])
def test_skill_tools_do_not_execute_when_gate_does_not_allow(tool, decision):
    async def run():
        worker = Worker()
        seen = []
        statuses = []

        async def request_json(method, path, body=None):
            seen.append(path)
            assert path == "/internal/tools/preexec"
            if decision == "unavailable":
                raise OSError("offline")
            return {"decision": decision, "reason": "test_policy"}

        async def status(task, state, **kwargs):
            statuses.append(state)

        worker.request_json = request_json
        worker._status = status
        result = await worker._invoke({"botId": "bot-1", "id": "task-1"}, {"name": tool, "arguments": {"name": "research"}}, authorize=True)
        assert seen == ["/internal/tools/preexec"]
        if decision == "ask":
            assert result is None and statuses == ["waiting_approval"]
        else:
            assert result["ok"] is False and result["status"] == "denied"

    asyncio.run(run())


def test_load_skill_preserves_unknown_name_and_close_match_error():
    async def run():
        worker = Worker()
        async def request_json(method, path, body=None):
            if path.endswith("/preexec"):
                return {"decision": "allow"}
            return {"ok": False, "status": "unknown_skill", "reason": "Unknown skill. Close matches: research"}
        worker.request_json = request_json
        result = await worker._invoke({"botId": "bot-1", "id": "task-1"}, {"name": "load_skill", "arguments": {"name": "reseach"}}, authorize=True)
        assert result["status"] == "unknown_skill" and "research" in result["reason"]
    asyncio.run(run())


def test_prompt_gets_only_catalog_lines_once_and_never_bodies():
    async def run():
        worker = Worker()
        seen = []

        async def request_json(method, path, body=None):
            seen.append((method, path))
            if path.endswith("/catalog"):
                return {"catalog": ["research: gather and cite facts"]}
            return {"message": {"role": "assistant", "content": "I can use research."}}

        worker.request_json = request_json
        messages = [{"role": "user", "content": "Research this."}]
        task = {"id": "task-1", "botId": "bot-1"}
        first = await worker._complete_model(task, messages)
        assert first["content"] == "I can use research."
        assert messages[0]["role"] == "system"
        assert "research: gather and cite facts" in messages[0]["content"]
        assert "Before acting, load the matching skill" in messages[0]["content"]
        assert "read_skill_file(name, path)" in messages[0]["content"]
        assert "# Private guide body" not in messages[0]["content"]
        await worker._complete_model(task, messages)
        assert seen.count(("GET", "/internal/skills/bot-1/catalog")) == 1

    asyncio.run(run())


def test_catalog_preserves_system_feedback_and_survives_resume_and_compaction():
    from compaction import apply_summary

    async def run():
        worker = Worker()
        catalog_calls = []
        async def request_json(method, path, body=None):
            if path.endswith("/catalog"):
                catalog_calls.append(path)
                return {"catalog": ["research: gather facts"]}
            return {"message": {"role": "assistant", "content": "Done"}}
        worker.request_json = request_json
        messages = [{"role": "system", "content": "Primary system rules, bot identity, feedback"}, {"role": "user", "content": "Original request"}]
        await worker._complete_model({"id": "task-1", "botId": "bot-1"}, messages)
        assert messages[0]["content"].startswith("Primary system rules, bot identity, feedback")
        for i in range(40):
            messages.append({"role": "assistant", "content": f"Prior work {i}"})
        compacted = apply_summary(messages, {"goal": "Continue original work"})
        assert len(compacted) < len(messages)
        assert compacted[0] == messages[0]
        # A fresh task dictionary models a new worker lease of the persisted transcript.
        await worker._complete_model({"id": "task-1", "botId": "bot-1"}, compacted)
        assert len(catalog_calls) == 1
        assert compacted[0]["content"].count("[skill-catalog]") == 1
    asyncio.run(run())
