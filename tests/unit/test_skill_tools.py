"""Worker guide skill tools stay behind scoped API endpoints and lazy catalog injection."""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services" / "agent"))

from worker import Worker, _ALLOW


def test_load_skill_requests_scoped_endpoint_and_returns_body_and_version():
    async def run():
        worker = Worker()
        seen = []

        async def request_json(method, path, body=None):
            seen.append((method, path, body))
            return {"name": "research", "body": "# Research", "version": 3}

        worker.request_json = request_json
        result = await worker._invoke({"botId": "bot-1", "id": "task-1"}, {"name": "load_skill", "arguments": {"name": "research"}}, authorize=True)
        assert seen == [("GET", "/internal/skills/bot-1/research", None)]
        assert result == {"ok": True, "name": "research", "body": "# Research", "version": 3}

    asyncio.run(run())


def test_load_skill_reports_unknown_name_with_close_matches():
    async def run():
        worker = Worker()

        async def request_json(method, path, body=None):
            response = httpx.Response(404, json={"error": "unknown_skill", "message": "Unknown skill. Close matches: research"}, request=httpx.Request(method, "http://api" + path))
            raise httpx.HTTPStatusError("not found", request=response.request, response=response)

        import httpx
        worker.request_json = request_json
        result = await worker._invoke({"botId": "bot-1", "id": "task-1"}, {"name": "load_skill", "arguments": {"name": "reseach"}}, authorize=True)
        assert result["error"] == "unknown_skill"
        assert "research" in result["message"]

    asyncio.run(run())


def test_write_skill_uses_policy_gate_before_write_endpoint():
    async def run():
        worker = Worker()
        seen = []

        async def authorize(task, name, args):
            seen.append(("authorize", name, args))
            return _ALLOW

        async def request_json(method, path, body=None):
            seen.append((method, path, body))
            return {"id": "skill-1", "version": 1}

        worker._authorize = authorize
        worker.request_json = request_json
        args = {"name": "daily-review", "title": "Daily review", "when_to_use": "When reviewing work", "body": "# Review"}
        result = await worker._invoke({"botId": "bot-1", "id": "task-1"}, {"name": "write_skill", "arguments": args}, authorize=True)
        assert seen[0] == ("authorize", "write_skill", args)
        assert seen[1] == ("POST", "/internal/skills/bot-1/write", args)
        assert result == {"ok": True, "id": "skill-1", "version": 1}

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
        assert "# Private guide body" not in messages[0]["content"]
        await worker._complete_model(task, messages)
        assert seen.count(("GET", "/internal/skills/bot-1/catalog")) == 1

    asyncio.run(run())
