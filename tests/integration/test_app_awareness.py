"""App map, link pills, and live state use the mock planner. No real model spend."""
from __future__ import annotations

import json
import re

from test_acceptance import OPENROUTER, login, result_text, wait_task


def test_bot_knows_the_app_and_its_own_state():
    client = login()
    status, saved = client.call(
        "POST",
        "/api/secrets",
        {"namespace": "openrouter", "name": "default", "type": "API_KEY", "value": OPENROUTER, "description": "byok"},
    )
    assert status == 200, saved

    status, bot = client.call("POST", "/api/bots", {"name": "Guide clerk", "role": "Guide", "instructions": ""})
    assert status == 200, bot
    bot_id = bot["id"]
    conversation = bot["conversationId"]
    status, routine = client.call(
        "POST",
        f"/api/bots/{bot_id}/routines",
        {"name": "Guide digest 1902", "cron": "0 9 * * *", "instruction": "Summarize the inbox"},
    )
    assert status == 200, routine

    status, sent = client.call(
        "POST",
        f"/api/conversations/{conversation}/messages",
        {"content": "Where do I connect OpenRouter?", "asTask": False},
    )
    assert status == 200, sent
    task = wait_task(client, bot_id, sent["taskId"])
    assert task["status"] == "completed", task
    assert "app://settings?id=vault" in result_text(task)

    status, prompts = client.call("GET", "/api/model-requests")
    assert status == 200, prompts
    blob = json.dumps(prompts)
    assert "Where do I connect OpenRouter?" in blob
    assert "Working on:" in blob
    assert "Guide digest 1902" in blob
    assert re.search(r"Computer: (busy|asleep|awake)", blob), blob[-1500:]
    assert "Connected:" in blob
    assert "OpenRouter" in blob
    assert "app://panel?tab=details" in blob
    assert "app://panel?tab=library" in blob
    assert "app://panel?tab=coding-jobs" in blob
    assert "Lead with the answer" in blob

    status, flux = client.call(
        "POST",
        f"/api/conversations/{conversation}/messages",
        {"content": "Where do I find the flux capacitor?", "asTask": False},
    )
    assert status == 200, flux
    flux_task = wait_task(client, bot_id, flux["taskId"])
    assert flux_task["status"] == "completed", flux_task
    flux_text = result_text(flux_task)
    assert "Flux" in flux_text
    assert "not-a-real-setting" not in flux_text
    assert "app://" not in flux_text

    status, quoted = client.call(
        "POST",
        f"/api/conversations/{conversation}/messages",
        {"content": "Reply to my last note with a wave", "asTask": False},
    )
    assert status == 200, quoted
    quote_task = wait_task(client, bot_id, quoted["taskId"])
    assert quote_task["status"] == "completed", quote_task
    status, workspace = client.call("GET", f"/api/bots/{bot_id}/workspace")
    assert status == 200, workspace
    reply = next(item for item in workspace["messages"] if item.get("content") == "On it.")
    assert reply["replyTo"] == quoted["messageId"]

    status, lovely = client.call(
        "POST",
        f"/api/conversations/{conversation}/messages",
        {"content": "that was lovely", "asTask": False},
    )
    assert status == 200, lovely
    lovely_task = wait_task(client, bot_id, lovely["taskId"])
    assert lovely_task["status"] == "completed", lovely_task
    status, workspace = client.call("GET", f"/api/bots/{bot_id}/workspace")
    assert status == 200, workspace
    note = next(item for item in workspace["messages"] if item["id"] == lovely["messageId"])
    assert any(item["emoji"] == "🌟" and item["actorType"] == "bot" for item in note.get("reactions") or [])
