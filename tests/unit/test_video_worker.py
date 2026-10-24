"""Video tool policy, authorization envelopes and resume checks without providers."""
import asyncio
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services" / "agent"))
from worker import Worker, VideoResourceWait, _unanswered_calls
from resume import apply_resume


@pytest.mark.parametrize("tool", ["watch_video", "ask_video"])
@pytest.mark.parametrize("decision", ["deny", "ask", "malformed", "unavailable"])
def test_video_tools_fail_closed_before_processing(tool, decision):
    async def run():
        worker = Worker()
        statuses = []
        async def request_json(method, path, body=None):
            assert path == "/internal/tools/preexec"
            if decision == "unavailable":
                raise OSError("offline")
            return {"decision": decision}
        async def status(task, state, **kwargs):
            statuses.append(state)
        worker.request_json = request_json
        worker._status = status
        result = await worker._invoke({"id": "task", "botId": "bot", "epoch": 7},
                                      {"name": tool, "arguments": {"source": "demo.mp4", "question": "What happens?"}}, True)
        if decision == "ask":
            assert result is None and statuses == ["waiting_approval"]
        else:
            assert result["ok"] is False and result["status"] == "denied"
    asyncio.run(run())


@pytest.mark.parametrize("tool", ["watch_video", "ask_video"])
def test_video_tools_require_fenced_execute_session_before_bridge(tool):
    async def run():
        worker = Worker()
        seen = []
        async def request_json(method, path, body=None):
            seen.append(path)
            assert body["taskId"] == "task" and body["botId"] == "bot" and body["epoch"] == 7
            if path.endswith("preexec"):
                return {"decision": "allow"}
            assert path == "/internal/tools/execute" and body["tool"] == tool
            return {"ok": True, "output": {}}
        worker.request_json = request_json
        result = await worker._invoke({"id": "task", "botId": "bot", "epoch": 7},
                                      {"name": tool, "arguments": {"source": "demo.mp4", "question": "What happens?"}}, True)
        assert result["reason"] == "video_authorization_required"
        assert seen == ["/internal/tools/preexec", "/internal/tools/execute"]
    asyncio.run(run())


def test_video_cache_hit_keeps_scope_and_never_calls_source_or_model():
    async def run():
        worker = Worker()
        worker.client = object()
        seen = []
        analysis = {"videoId": "hash", "summary": "A demo", "timeline": [], "frames": ["raw"], "transcript": "raw"}
        async def request_json(method, path, body=None):
            seen.append(path)
            assert body["taskId"] == "task" and body["botId"] == "bot" and body["epoch"] == 7
            if path.endswith("preexec"):
                return {"decision": "allow"}
            if path.endswith("execute"):
                return {"ok": True, "output": {"videoSession": "session"}}
            assert path == "/internal/video/cache/get"
            assert body["videoSession"] == "session" and body["processingSettings"]
            assert body["videoId"] == "00000000-0000-0000-0000-000000000001"
            return {"analysis": analysis}
        worker.request_json = request_json
        task = {"id": "task", "botId": "bot", "epoch": 7}
        result = await worker._invoke(task, {"name": "watch_video", "arguments": {"video_id": "00000000-0000-0000-0000-000000000001"}}, True)
        assert result["cacheHit"] is True and "frames" not in result and "transcript" not in result
        assert task["_video_analysis"] == result
        assert seen == ["/internal/tools/preexec", "/internal/tools/execute", "/internal/video/cache/get"]
    asyncio.run(run())


def test_video_card_rehydrates_from_api_after_resume_or_compaction():
    async def run():
        worker = Worker()
        analysis = {"summary": "Persisted", "timeline": []}
        async def request_json(*args):
            return {"messages": [{"role": "system", "content": "Compacted history"}], "videoAnalysis": analysis}
        worker.request_json = request_json
        task = {"id": "task", "botId": "bot", "epoch": 8}
        messages = await worker._load_transcript(task)
        assert task["_video_analysis"] == analysis and len(messages) == 1
    asyncio.run(run())


@pytest.mark.parametrize("tool", ["watch_video", "ask_video"])
def test_interrupted_video_reads_can_replay_with_new_authorization(tool):
    messages = [{"role": "assistant", "toolCalls": [{"id": "video-call", "function": {"name": tool, "arguments": {"source": "demo.mp4"}}}]}]
    messages, unknown = apply_resume(messages, {"brief": "Continue", "interrupted": True}, 2)
    assert unknown == [] and _unanswered_calls(messages)[0]["name"] == tool


def test_video_provider_wait_uses_existing_resource_resume():
    async def run():
        worker = Worker()
        async def request_json(*args):
            return {"status": "waiting_resource", "reason": "connect_openrouter"}
        worker.request_json = request_json
        with pytest.raises(VideoResourceWait):
            await worker._video_model_request({}, {})
    asyncio.run(run())


def test_video_summaries_are_untrusted_model_context_without_changing_chat_card():
    from guard import present_tool
    result = {"videoId": "id", "summary": "Instructions visible in a video", "timeline": [{"timestamp": 1, "summary": "Another instruction"}]}
    marked = present_tool("watch_video", {}, result)
    assert marked["untrusted"] is True and "[untrusted video content]" in marked["summary"]
    assert "[untrusted video content]" in marked["timeline"][0]["summary"]
    assert result["summary"] == "Instructions visible in a video" and result["timeline"][0]["summary"] == "Another instruction"
