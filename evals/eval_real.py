#!/usr/bin/env python3
"""Real-model eval. Not part of make test or CI.

Requires OPENROUTER_API_KEY in the operator shell. The key is stored with
SecretBroker as secret://openrouter/default. It is never printed.

Before running, point the API at OpenRouter and restart it:

  LLM_PROVIDER=openrouter
  OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
  MODEL_PLANNER=anthropic/claude-haiku-5.5

The mock stack cannot grade a real model.
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

def required_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is required to run the real eval")
    return value

STACK = required_env("STACK")
BASE = required_env("BASE_URL").rstrip("/")
TASKS = [
    "Open http://portal.example.edu:8099/article.html and tell me the page title and the first heading.",
    "Terminal: write the word pong into /workspace/notes/ping.txt",
    "Remember that the lab door code phrase is north gate. What phrase did I just ask you to remember?",
]


def call(method: str, path: str, body=None, cookie=""):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(BASE + path, data=data, method=method)
    if body is not None:
        request.add_header("Content-Type", "application/json")
    if cookie:
        request.add_header("Cookie", cookie)
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            payload = response.read().decode()
            set_cookie = response.headers.get("Set-Cookie", "")
            if "teammates_session=" in set_cookie:
                cookie = set_cookie.split(";", 1)[0]
            parsed = json.loads(payload) if payload else {}
            return response.status, parsed, cookie
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode() or "{}"), cookie


def main() -> int:
    key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not key:
        print("OPENROUTER_API_KEY is missing", file=sys.stderr)
        return 2
    status, health, _ = call("GET", "/health")
    provider = (health or {}).get("llmProvider") if isinstance(health, dict) else None
    if provider == "mock":
        print("API LLM_PROVIDER is still mock. Restart the API with LLM_PROVIDER=openrouter and OPENROUTER_BASE_URL=https://openrouter.ai/api/v1", file=sys.stderr)
        return 3
    cookie = ""
    status, _, cookie = call(
        "POST",
        "/api/auth/login",
        {"username": os.environ.get("OWNER_USERNAME", "saad"), "password": os.environ.get("OWNER_PASSWORD", "teammates-dev")},
    )
    if status != 200:
        print("login failed", status, file=sys.stderr)
        return 4
    status, probe, cookie = call("POST", "/api/secrets/test", {"value": key}, cookie)
    if status != 200 or not probe.get("ok"):
        print("key was rejected by the provider", file=sys.stderr)
        return 5
    status, existing, cookie = call("GET", "/api/secrets", cookie=cookie)
    current = next((item for item in existing if item.get("provider") == "openrouter" and item.get("name") == "default"), None)
    if current:
        status, _, cookie = call("POST", f"/api/secrets/{current['id']}/rotate", {"value": key}, cookie)
    else:
        status, _, cookie = call(
            "POST",
            "/api/secrets",
            {"namespace": "openrouter", "name": "default", "type": "API_KEY", "value": key, "description": "eval"},
            cookie,
        )
    if status != 200:
        print("could not store the key", status, file=sys.stderr)
        return 6
    status, bot, cookie = call(
        "POST",
        "/api/bots",
        {"name": "Eval clerk", "role": "Eval", "instructions": "Use tools. Finish the task."},
        cookie,
    )
    if status != 200:
        print("bot create failed", bot, file=sys.stderr)
        return 7
    rows = []
    for instruction in TASKS:
        started = time.time()
        status, created, cookie = call(
            "POST",
            f"/api/conversations/{bot['conversationId']}/messages",
            {"content": instruction, "asTask": True},
            cookie,
        )
        task_id = created.get("taskId")
        final = None
        deadline = time.time() + 240
        while time.time() < deadline:
            status, tasks, cookie = call("GET", f"/api/bots/{bot['id']}/tasks", cookie=cookie)
            final = next(item for item in tasks if item["id"] == task_id)
            if final["status"] in {"completed", "failed", "cancelled"}:
                break
            time.sleep(2)
        elapsed = time.time() - started
        rows.append(
            {
                "instruction": instruction,
                "status": None if final is None else final.get("status"),
                "modelCalls": None if final is None else final.get("modelCalls"),
                "seconds": round(elapsed, 1),
            }
        )
        print(json.dumps(rows[-1]))
    ok = all(row["status"] == "completed" for row in rows)
    print(json.dumps({"ok": ok, "tasks": rows}))
    return 0 if ok else 8


if __name__ == "__main__":
    sys.exit(main())
