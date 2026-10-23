from __future__ import annotations

import asyncio
import importlib.util
import sys
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services/agent"))
from worker import Worker


def test_lost_lease_cancels_inflight_computer_action():
    async def run():
        worker = Worker()
        request = httpx.Request("POST", "http://api/internal/tasks/task/heartbeat")
        response = httpx.Response(409, request=request)
        async def lost_lease(*args, **kwargs):
            raise httpx.HTTPStatusError("lease lost", request=request, response=response)
        worker.request = lost_lease
        stopped = asyncio.Event()
        lost = asyncio.Event()
        action_started = asyncio.Event()
        async def action():
            action_started.set()
            await asyncio.Event().wait()
        action_task = asyncio.create_task(action())
        await action_started.wait()
        await worker._heartbeat({"id": "task", "epoch": 1}, stopped, lost, action_task)
        assert lost.is_set()
        try:
            await action_task
        except asyncio.CancelledError:
            pass
        assert action_task.cancelled()
    asyncio.run(run())


def test_desktop_busy_response_is_recognized_without_logging_payload():
    from worker import _desktop_busy
    request = httpx.Request("POST", "http://api/internal/tools/execute")
    response = httpx.Response(409, request=request, json={"detail": {"code": "DESKTOP_BUSY"}})
    assert _desktop_busy(response)
    assert not _desktop_busy(httpx.Response(409, request=request, json={"error": "other"}))
