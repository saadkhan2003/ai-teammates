"""Attached video analysis and cache behavior on the deterministic mock stack."""
import shutil
import subprocess
import uuid

import pytest

from test_acceptance import OPENROUTER, _psql, submit, wait_task
from test_bot_messaging import _workspace


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg is required to generate the integration fixture")
def test_attached_video_followup_reuses_transcription(tmp_path, bot_factory):
    from test_acceptance import login

    client = login()
    assert client.call("POST", "/api/secrets", {"namespace": "openrouter", "name": "default", "type": "API_KEY", "value": OPENROUTER})[0] == 200
    bot = bot_factory(client, "Video watch " + uuid.uuid4().hex[:6])
    sibling_bot = bot_factory(client, "Video sibling " + uuid.uuid4().hex[:6])
    conversation = _workspace(client, bot)["conversationId"]
    fixture = tmp_path / "test-video.mp4"
    subprocess.run([
        "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=2:duration=3",
        "-f", "lavfi", "-i", "sine=frequency=1000:duration=3", "-shortest", "-y", str(fixture),
    ], check=True)
    workspace_path = f"/workspace/uploads/{uuid.uuid4().hex}.mp4"
    status, uploaded = client.call("PUT", f"/api/bots/{bot}/files", raw=fixture.read_bytes(), headers={"x-path": workspace_path, "Content-Type": "video/mp4"})
    assert status == 200, uploaded
    status, attached = client.call("POST", f"/api/conversations/{conversation}/messages", {"content": f"[attached: {workspace_path}]", "asTask": False})
    assert status == 200, attached
    status, listing = client.call("GET", f"/api/bots/{bot}/library")
    assert status == 200, listing
    item = next(row for group in listing["groups"] for row in group["items"] if row["name"].endswith(".mp4"))

    own_path_task = submit(client, conversation, f"VIDEO_V1_PATH_TEST:{workspace_path}")
    own_path = wait_task(client, bot, own_path_task, timeout=180)
    assert own_path["status"] == "completed", own_path
    sibling_path = f"/data/workspace/bots/{sibling_bot.replace('-', '')}/uploads/{uuid.uuid4().hex}.mp4"
    sibling_task = submit(client, conversation, f"VIDEO_V1_PATH_TEST:{sibling_path}")
    sibling_result = wait_task(client, bot, sibling_task, timeout=180)
    assert sibling_result["status"] == "completed", sibling_result
    assert _psql(f"SELECT count(*) FROM task_steps WHERE task_id='{sibling_task}' AND tool='watch_video' AND result::text LIKE '%video_unavailable%'") == "1"
    outside_task = submit(client, conversation, "VIDEO_V1_PATH_TEST:/tmp/outside-video.mp4")
    outside_result = wait_task(client, bot, outside_task, timeout=180)
    assert outside_result["status"] == "completed", outside_result
    assert _psql(f"SELECT count(*) FROM task_steps WHERE task_id='{outside_task}' AND tool='watch_video' AND result::text LIKE '%video_unavailable%'") == "1"

    first = wait_task(client, bot, submit(client, conversation, f"VIDEO_V1_TEST:{item['id']}"), timeout=180)
    assert first["status"] == "completed", first
    transcription_count = _psql(f"SELECT count(*) FROM model_requests WHERE bot_id='{bot}' AND prompt_json->>'kind'='video_transcription'")
    vision_count = _psql(f"SELECT count(*) FROM model_requests WHERE bot_id='{bot}' AND prompt_json->>'kind'='video_vision'")
    assert int(transcription_count) >= 1 and int(vision_count) >= 1
    followup = wait_task(client, bot, submit(client, conversation, f"VIDEO_V1_FOLLOWUP:{item['id']}"), timeout=180)
    assert followup["status"] == "completed", followup
    assert _psql(f"SELECT count(*) FROM model_requests WHERE bot_id='{bot}' AND prompt_json->>'kind'='video_transcription'") == transcription_count
    assert _psql(f"SELECT count(*) FROM model_requests WHERE bot_id='{bot}' AND prompt_json->>'kind'='video_vision'") == vision_count
