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


def test_feedback_is_folded_into_an_existing_transcript_once():
    from worker import _fold_feedback

    note = "Hidden feedback, not chat and no reply expected: the user reacted 🎉 on message m1."
    messages = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "do it"},
        {"role": "assistant", "content": "", "toolCalls": [{"id": "c1", "name": "shell", "args": {}}]},
    ]
    _fold_feedback(messages, note)
    _fold_feedback(messages, note)
    assert messages[0]["content"].count(note) == 1
    assert messages[-1]["role"] == "assistant" and len(messages) == 3
    _fold_feedback(messages, "")
    assert messages[0]["content"] == "sys\n" + note


def test_lease_loop_survives_api_restart():
    async def run():
        worker = Worker()
        calls = {"n": 0}
        async def flaky(*args, **kwargs):
            calls["n"] += 1
            if calls["n"] == 1:
                raise httpx.ConnectError("All connection attempts failed")
            raise asyncio.CancelledError()
        worker.request_json = flaky
        async def fast_sleep(_):
            return None
        real_sleep = asyncio.sleep
        asyncio.sleep = fast_sleep
        try:
            try:
                await worker.lease_loop()
            except asyncio.CancelledError:
                pass
        finally:
            asyncio.sleep = real_sleep
        assert calls["n"] == 2
    asyncio.run(run())
