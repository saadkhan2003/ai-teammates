"""Video worker path against the mock model/transcription stack."""
import shutil
import subprocess
import uuid

import pytest

from test_acceptance import login, submit, wait_task
from test_bot_messaging import _bot, _cleanup, _workspace


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="fixture generation requires host ffmpeg")
def test_attached_video_analysis_and_private_cache():
    client = login()
    bot = _bot(client, "Video" + uuid.uuid4().hex[:6])
    try:
        conversation = _workspace(client, bot)["conversationId"]
        name = "video-" + uuid.uuid4().hex[:8] + ".mp4"
        path = f"/workspace/uploads/{name}"
        fixture = subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=2:duration=4",
                                  "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-shortest", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1"],
                                 capture_output=True, check=True).stdout
        assert client.call("PUT", f"/api/bots/{bot}/files", raw=fixture,
                           headers={"x-path": path, "Content-Type": "video/mp4"})[0] == 200
        assert client.call("POST", f"/api/conversations/{conversation}/messages",
                           {"content": f"[attached: {path}]", "asTask": False})[0] == 200
        status, listing = client.call("GET", f"/api/bots/{bot}/library?kind=video")
        assert status == 200
        item = next(row for group in listing["groups"] for row in group["items"] if row["name"] == name)
        task_id = submit(client, conversation, f"VIDEO_V1_TEST:{item['id']}")
        result = wait_task(client, bot, task_id, timeout=240)
        assert result.get("status") == "completed", result
        assert "Video test complete" in result.get("result", "")
    finally:
        _cleanup(client, bot)


def test_video_bridge_requires_policy_authorization_and_matching_lease():
    from test_acceptance import _psql, worker_call
    from test_skills_v2 import _skill_task
    client = login()
    bot = _bot(client, "VideoFence" + uuid.uuid4().hex[:5])
    other = _bot(client, "VideoOther" + uuid.uuid4().hex[:5])
    status, original = client.call("GET", "/api/policy")
    assert status == 200
    try:
        envelope = dict(_skill_task(client, bot, {"source": "/workspace/demo.mp4"}), tool="watch_video")
        scope = {key: envelope[key] for key in ("taskId", "botId", "epoch")}
        for operation in ("source", "cache/get", "cache/put", "model"):
            with pytest.raises(AssertionError, match="403"):
                worker_call("POST", f"/internal/video/{operation}", scope)
        for endpoint in ("preexec", "authorize", "execute"):
            with pytest.raises(AssertionError, match="409"):
                worker_call("POST", f"/internal/tools/{endpoint}", dict(envelope, botId=other))
        allowed_policy = dict(original, classes=dict(original["classes"], read="allow"))
        assert client.call("PUT", "/api/policy", allowed_policy)[0] == 200
        authorized = worker_call("POST", "/internal/tools/execute", envelope)
        scope["videoSession"] = authorized["output"]["videoSession"]
        # Workspace cache calls need a content hash; no computer or model is touched.
        scope["contentSha"] = "test-content-hash"
        analysis = {"summary": "Safe cached summary", "timeline": [], "frames": [], "transcript": ""}
        assert worker_call("POST", "/internal/video/cache/put", dict(scope, analysis=analysis))["ok"]
        assert worker_call("POST", "/internal/video/cache/get", scope)["analysis"]["summary"] == analysis["summary"]
        # Source substitution is ignored: the session fixes the original workspace source.
        assert worker_call("POST", "/internal/video/cache/get", dict(scope, sourcePath="other.mp4"))["analysis"]["summary"] == analysis["summary"]
        # Source/cache privacy survives owner/bot/epoch changes and worker retries.
        for changed in (dict(scope, botId=other), dict(scope, epoch=2), dict(scope, videoSession=str(uuid.uuid4()))):
            with pytest.raises(AssertionError, match="409|403"):
                worker_call("POST", "/internal/video/cache/get", changed)
        assert worker_call("GET", f"/internal/tasks/{scope['taskId']}/transcript")["videoAnalysis"]["summary"] == analysis["summary"]
        assert _psql(f"SELECT count(*) FROM task_steps WHERE task_id='{scope['taskId']}' AND tool='watch_video'") == "1"
        # A policy revocation applies even to an already issued session.
        for mode in ("deny", "ask"):
            assert client.call("PUT", "/api/policy", dict(original, classes=dict(original["classes"], read=mode)))[0] == 200
            if mode == "deny":
                with pytest.raises(AssertionError, match="403"):
                    worker_call("POST", "/internal/video/cache/get", scope)
            else:
                with pytest.raises(AssertionError, match="409"):
                    worker_call("POST", "/internal/video/cache/get", scope)
                assert _psql(f"SELECT count(*) FROM approvals WHERE task_id='{scope['taskId']}' AND action='watch_video' AND status='pending'") == "1"
    finally:
        assert client.call("PUT", "/api/policy", original)[0] == 200
        _cleanup(client, other)
        _cleanup(client, bot)
