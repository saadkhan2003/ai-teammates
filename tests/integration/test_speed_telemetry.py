"""Phase 0 telemetry against an isolated mock stack. Never runs a real model."""
import json
import os
import time
import uuid

import pytest

from test_acceptance import Client, OPENROUTER, _psql, login, submit, wait_task
from test_bot_messaging import _workspace


def test_rum_records_clamped_content_free_samples_and_staff_speed_counts():
    owner = login()
    marker = 123.456789
    status, _ = owner.call("POST", "/api/rum", {"events": [
        {"name": "echo_ms", "value_ms": marker, "route": "/bots/[id]", "attrs": {"text": "private-sentinel", "count": 1}},
        {"name": "ack_ms", "value_ms": -1},
        {"name": "inp_ms", "value_ms": 999999},
    ]})
    assert status == 202
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        status, report = owner.call("GET", "/api/admin/speed?hours=24")
        assert status == 200
        metrics = {m["key"]: m for m in report["metrics"]}
        if _psql(f"SELECT count(*) FROM perf_events WHERE name='echo_ms' AND value_ms={marker}") != "0":
            break
        time.sleep(.5)
    assert metrics["echo_ms"]["count"] > 0
    assert set(metrics) == {"echo_ms", "ack_ms", "server_ttft_ms", "model_total_ms", "first_token_screen_ms", "tool_chip_ms", "chat_switch_ms", "sse_fanout_ms", "api_json_ms", "wake_paused_ms", "warm_pool_ready_ms", "lcp_ms", "inp_ms", "cache_hit_share", "first_load_js_kb"}
    assert report["window_hours"] == 24
    rows = _psql(f"SELECT attrs::text FROM perf_events WHERE name='echo_ms' AND value_ms={marker} ORDER BY id DESC LIMIT 1")
    assert "private-sentinel" not in rows and json.loads(rows) == {"count": 1}
    assert owner.call("POST", "/api/rum", {"events": [{"name": "server_ttft_ms", "value_ms": 1}]})[0] == 400
    assert owner.call("POST", "/api/rum", {"events": [{"name": "echo_ms", "value_ms": 1}] * 51})[0] == 400
    assert owner.call("POST", "/api/rum", {"events": []}, headers={"Origin": "https://cross-site.invalid", "Sec-Fetch-Site": "cross-site"})[0] == 403
    assert Client().call("POST", "/api/rum", {"events": []})[0] == 401
    assert owner.call("GET", "/api/admin/speed?hours=999")[1]["window_hours"] == 168


def test_member_can_submit_rum_but_cannot_read_admin_speed():
    owner = login()
    tag = uuid.uuid4().hex[:12]
    status, invite = owner.call("POST", "/api/invitations", {"email": f"speed-{tag}@example.test", "role": "member"})
    assert status == 200
    member = Client()
    status, accepted = member.call("POST", "/api/invitations/accept", {"token": invite["token"], "username": f"speed-{tag}", "password": "speed-test-member-only"}, auth=False)
    assert status == 200
    try:
        assert member.call("POST", "/api/rum", {"events": [{"name": "chat_switch_ms", "value_ms": 12}]})[0] == 202
        assert member.call("GET", "/api/admin/speed")[0] == 403
    finally:
        owner.call("PATCH", f"/api/admin/users/{accepted['id']}", {"status": "disabled"})


@pytest.mark.skipif(os.environ.get("LLM_PROVIDER") != "mock", reason="Mock-only model telemetry check")
def test_mock_model_calls_have_provider_wall_time_and_cache_counts(bot_factory):
    owner = login()
    assert owner.call("POST", "/api/secrets", {"namespace": "openrouter", "name": "default", "type": "API_KEY", "value": OPENROUTER})[0] == 200
    bot = bot_factory(owner, "Speed " + uuid.uuid4().hex[:6])
    task = submit(owner, _workspace(owner, bot)["conversationId"], "What should I call you?")
    assert wait_task(owner, bot, task)["status"] == "completed"
    rows = json.loads(_psql(f"SELECT coalesce(json_agg(t), '[]'::json) FROM (SELECT ttft_ms,total_ms,cached_tokens FROM model_calls WHERE task_id='{task}'::uuid) t"))
    assert rows and all(r["total_ms"] is not None and r["ttft_ms"] == r["total_ms"] and r["total_ms"] >= 0 for r in rows)
    assert all(r["cached_tokens"] is not None for r in rows)
    status, speed = owner.call("GET", "/api/admin/speed")
    assert status == 200
    metrics = {m["key"]: m for m in speed["metrics"]}
    assert metrics["server_ttft_ms"]["count"] >= len(rows) and metrics["model_total_ms"]["count"] >= len(rows)
