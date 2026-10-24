"""OpenRouter-shaped HTTP stub. Logs message counts only."""
from __future__ import annotations

import hashlib
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from planner import plan


def limit_remaining(token: str) -> int:
    digest = hashlib.sha256(token.encode()).hexdigest()
    return int(digest[:4], 16) % 50000


def authorized(header: str) -> str | None:
    if not header.startswith("Bearer "):
        return None
    token = header[7:].strip()
    if token.startswith("sk-or-") and len(token) >= 20:
        return token
    return None


CALLS: dict[str, int] = {}
CALL_LOCK = threading.Lock()


def count(path: str) -> None:
    with CALL_LOCK:
        CALLS[path] = CALLS.get(path, 0) + 1


def anthropic_messages(payload: dict) -> list:
    messages = []
    system = payload.get("system", [])
    if isinstance(system, str):
        messages.append({"role": "system", "content": system})
    else:
        for block in system:
            messages.append({"role": "system", "content": block.get("text", "")})
    for message in payload.get("messages", []):
        content = message.get("content", [])
        if isinstance(content, str):
            messages.append({"role": message.get("role", "user"), "content": content})
            continue
        text, calls = [], []
        for block in content:
            if block.get("type") == "text":
                text.append(block.get("text", ""))
            elif block.get("type") == "tool_use":
                calls.append({"id": block["id"], "type": "function", "function": {"name": block["name"], "arguments": json.dumps(block.get("input", {}))}})
            elif block.get("type") == "tool_result":
                messages.append({"role": "tool", "tool_call_id": block["tool_use_id"], "content": block.get("content", "")})
        if text or calls:
            item = {"role": message.get("role", "user"), "content": "\n".join(text)}
            if calls:
                item["tool_calls"] = calls
            messages.append(item)
    return messages


def anthropic_response(response: dict) -> dict:
    message = response["choices"][0]["message"]
    content = []
    if message.get("content"):
        content.append({"type": "text", "text": message["content"]})
    for call in message.get("tool_calls", []):
        content.append({"type": "tool_use", "id": call["id"], "name": call["function"]["name"], "input": json.loads(call["function"]["arguments"])})
    usage = response.get("usage", {})
    return {"id": "msg_mock", "type": "message", "role": "assistant", "content": content, "stop_reason": "tool_use" if message.get("tool_calls") else "end_turn", "usage": {"input_tokens": usage.get("prompt_tokens", 1), "output_tokens": usage.get("completion_tokens", 1), "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:
        return

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        if path == "/__calls":
            with CALL_LOCK:
                snapshot = dict(CALLS)
            self._send(200, snapshot)
            return
        token = authorized(self.headers.get("Authorization", "") or "Bearer " + self.headers.get("x-api-key", ""))
        if token is None:
            self._send(401, {"error": "unauthorized"})
            return
        if path in ("/api/v1/models", "/p2/v1/models", "/anthropic/v1/models"):
            count(path)
            self._send(200, {"data": [{"id": "mock/planner"}]})
            return
        if path == "/api/v1/key":
            count(path)
            self._send(200, {"data": {"limit_remaining": limit_remaining(token)}})
            return
        self._send(404, {"error": "not_found"})

    def do_POST(self) -> None:
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        token = authorized(self.headers.get("Authorization", "") or "Bearer " + self.headers.get("x-api-key", ""))
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length else b""
        if token is None:
            self._send(401, {"error": "unauthorized"})
            return
        count(path)
        if path == "/api/v1/audio/transcriptions":
            try:
                payload = json.loads(raw.decode("utf-8") if raw else "{}")
            except json.JSONDecodeError:
                self._send(400, {"error": "invalid json"})
                return
            provider = (payload.get("provider") or {}).get("order", ["mock"])[0]
            self._send(200, {"text": "Mock transcription.", "segments": [{"start": 0, "end": 1, "text": "Mock transcription."}], "provider": provider})
            return
        if path not in ("/api/v1/chat/completions", "/p2/v1/chat/completions", "/anthropic/v1/messages"):
            self._send(404, {"error": "not_found"})
            return
        try:
            payload = json.loads(raw.decode("utf-8") if raw else "{}")
        except json.JSONDecodeError:
            self._send(400, {"error": "invalid json"})
            return
        messages = anthropic_messages(payload) if path == "/anthropic/v1/messages" else payload.get("messages") if isinstance(payload, dict) else None
        if not isinstance(messages, list):
            messages = []
        print(f"messages={len(messages)}", flush=True)
        response = plan(messages)
        self._send(200, anthropic_response(response) if path == "/anthropic/v1/messages" else response)

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    port = int(os.environ.get("PORT", "8090"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
