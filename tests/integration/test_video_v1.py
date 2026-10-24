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
