"""Run only on the orchestrator's isolated LLM_PROVIDER=mock stack."""
import json
import time
import uuid
from test_acceptance import OPENROUTER, _psql, login, submit, wait_task
from test_bot_messaging import _bot, _cleanup, _workspace


def eventually(check, timeout=40):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(.5)
    raise AssertionError("Learning condition did not become true")


def test_owner_reaction_next_turn_learning_correction_and_delete():
    client = login()
    bot = _bot(client, "Learn" + uuid.uuid4().hex[:6])
    try:
        assert client.call("POST", "/api/secrets", {"namespace": "openrouter", "name": "default", "type": "API_KEY", "value": OPENROUTER})[0] == 200
        conversation = _workspace(client, bot)["conversationId"]
        first = submit(client, conversation, "What should I call you?", as_task=False)
        assert wait_task(client, bot, first)["status"] == "completed"
        message = next(m for m in reversed(_workspace(client, bot)["messages"]) if m["role"] == "assistant" and m.get("requestId") == first)
        before = _psql(f"SELECT count(*) FROM tasks WHERE bot_id='{bot}'")
        assert client.call("POST", f"/api/messages/{message['id']}/reactions", {"emoji": "👍"})[0] == 200
        notes = eventually(lambda: client.call("GET", f"/api/bots/{bot}/learned")[1])
        assert notes[0]["kind"] in {"quality_bar", "preference"}
        assert notes[0]["source"]["messageId"] == message["id"]
        assert _psql(f"SELECT count(*) FROM tasks WHERE bot_id='{bot}'") == before, "Reaction must not enqueue work"
        next_turn = submit(client, conversation, "What should I call you?", as_task=False)
        assert wait_task(client, bot, next_turn)["status"] == "completed"
        # The existing gateway ledger captures the redacted request actually sent to the mock.
        prompt = _psql(f"SELECT prompt_json::text FROM model_requests WHERE task_id='{next_turn}' ORDER BY created_at")
        assert '[The user reacted 👍 to your message:' in prompt
        assert "Quality bar:" in prompt or "Preference:" in prompt
        assert _psql(f"SELECT count(*) FROM approval_signals WHERE bot_id='{bot}' AND consumed_at IS NOT NULL") == "1"
        for _ in range(2):
            status, correction = client.call("POST", f"/api/conversations/{conversation}/messages", {"parts": [{"type": "reply", "messageId": message["id"]}, {"type": "text", "text": "no, shorter please"}]})
            assert status == 200
            eventually(lambda: any(n["kind"] in {"avoid", "preference"} and "shorter" in n["text"] for n in client.call("GET", f"/api/bots/{bot}/learned")[1]))
        learned = client.call("GET", f"/api/bots/{bot}/learned")[1]
        shorter = [n for n in learned if "shorter" in n["text"]]
        assert len(shorter) == 1 and len(learned) == 1
        note = shorter[0]
        assert client.call("DELETE", f"/api/bots/{bot}/learned/{note['id']}")[0] == 204
        assert client.call("GET", f"/api/bots/{bot}/learned")[1] == []
        # Reprocessing the same durable signals cannot revive the owner-deleted note.
        _psql(f"UPDATE approval_signals SET learned_at=NULL WHERE bot_id='{bot}'")
        eventually(lambda: _psql(f"SELECT count(*) FROM approval_signals WHERE bot_id='{bot}' AND learned_at IS NULL") == "0")
        assert client.call("GET", f"/api/bots/{bot}/learned")[1] == []
    finally:
        _cleanup(client, bot)
