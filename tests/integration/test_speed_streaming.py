"""Mock-only Phase 1/2 contracts. Run only through the isolated-stack orchestrator."""
import json
import os
import uuid

import pytest
from test_acceptance import OPENROUTER, _psql, login, wait_task
from test_bot_messaging import _workspace

pytestmark = pytest.mark.skipif(os.environ.get("LLM_PROVIDER") != "mock", reason="Requires an isolated mock provider stack")


def test_client_id_retries_create_one_message_and_one_streamed_task(bot_factory):
    owner = login()
    assert owner.call("POST", "/api/secrets", {"namespace":"openrouter", "name":"default", "type":"API_KEY", "value":OPENROUTER})[0] == 200
    bot = bot_factory(owner, "Streaming " + uuid.uuid4().hex[:8])
    conversation = _workspace(owner, bot)["conversationId"]
    client_id = str(uuid.uuid4())
    body = {"content":"SPEED STREAM DEMO", "client_id":client_id}
    status, first = owner.call("POST", f"/api/conversations/{conversation}/messages", body)
    assert status == 200 and first["client_id"] == client_id
    status, retried = owner.call("POST", f"/api/conversations/{conversation}/messages", body)
    assert status == 200 and first["taskId"] == retried["taskId"]
    assert wait_task(owner, bot, first["taskId"])["status"] == "completed"
    workspace = _workspace(owner, bot)
    echoes = [m for m in workspace["messages"] if m.get("clientId") == client_id]
    assert len(echoes) == 1 and echoes[0]["id"] == first["messageId"]
    rows = json.loads(_psql(f"SELECT json_agg(t) FROM (SELECT ttft_ms,total_ms,prompt_tokens,completion_tokens FROM model_calls WHERE task_id='{first['taskId']}'::uuid) t"))
    assert rows and all(0 <= r["ttft_ms"] < r["total_ms"] and r["prompt_tokens"] > 0 and r["completion_tokens"] > 0 for r in rows)
