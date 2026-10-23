"""The worker backs off while a computer is being rebuilt."""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services" / "agent"))

from worker import RECOVERING, Worker, _computer_recovering


def test_recovering_status_is_typed():
    assert _computer_recovering(httpx.Response(503, json={"error": RECOVERING}))
    assert _computer_recovering(httpx.Response(409, json={"status": RECOVERING}))
    assert not _computer_recovering(httpx.Response(500, json={"error": "Internal error."}))
    assert not _computer_recovering(httpx.Response(503, json={"error": "unavailable"}))
    assert not _computer_recovering(httpx.Response(409, content=b""))


def test_tool_call_waits_instead_of_retrying_recovering():
    asyncio.run(_backs_off())


async def _backs_off() -> None:
    calls: list[tuple[str, dict]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode() or "{}")
        calls.append((request.url.path, body))
        if len(calls) > 4:
            return httpx.Response(400, json={"error": "retried"})
        if request.url.path == "/internal/tools/execute":
            return httpx.Response(503, json={"error": RECOVERING})
        return httpx.Response(200, json={"ok": True})

    worker = Worker()
    worker.worker_id = "worker-test"
    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport, base_url="http://api") as client:
        worker.client = client
        result = await worker._execute_api(
            {"id": "task-1", "botId": "bot-1", "epoch": 3},
            "write_file",
            {"path": "/workspace/notes/ping.txt", "content": "pong\n"},
        )
    assert result is None
    assert [path for path, _body in calls].count("/internal/tools/execute") == 1
    status = next(body for path, body in calls if path.endswith("/status"))
    assert status["status"] == "waiting_resource"
    assert status["reason"] == RECOVERING
    assert status["epoch"] == 3
    assert any(path == "/internal/tasks/task-1/status" for path, _body in calls)
