"""OpenRouter-shaped HTTP stub. Logs message counts only."""
from __future__ import annotations

import hashlib
import json
import os
from collections import OrderedDict
from threading import Lock
import time
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


_prefixes: OrderedDict[str, None] = OrderedDict()
_prefix_lock = Lock()


def cached_usage(messages: list, prompt_tokens: int) -> int:
    # Bounded hashes only: repeated system + first user prefix gets a deterministic 75% hit.
    prefix = json.dumps(messages[:2], sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(prefix.encode()).hexdigest()
    with _prefix_lock:
        repeated = digest in _prefixes
        _prefixes[digest] = None
        _prefixes.move_to_end(digest)
        while len(_prefixes) > 1024:
            _prefixes.popitem(last=False)
    return prompt_tokens * 3 // 4 if repeated else 0
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
    cached = usage.get("prompt_tokens_details", {}).get("cached_tokens", 0)
    return {"model": response.get("model", "mock/planner"), "id": "msg_mock", "type": "message", "role": "assistant", "content": content, "stop_reason": "tool_use" if message.get("tool_calls") else "end_turn", "usage": {"input_tokens": max(0, usage.get("prompt_tokens", 1) - cached), "output_tokens": usage.get("completion_tokens", 1), "cache_read_input_tokens": cached, "cache_creation_input_tokens": 0}}


def stream_frames(response: dict, anthropic: bool = False):
    """Deterministic small frames for all mock adapters, including split tool JSON."""
    message = response["choices"][0]["message"]
    if anthropic:
        native = anthropic_response(response)
        yield {"type": "message_start", "message": {"id": "msg_mock", "model": native["model"], "role": "assistant", "content": [], "usage": {**native["usage"], "output_tokens": 0}}}
        for index, block in enumerate(native["content"]):
            start = {"type": "tool_use", "id": block["id"], "name": block["name"], "input": {}} if block["type"] == "tool_use" else {"type": "text", "text": ""}
            yield {"type": "content_block_start", "index": index, "content_block": start}
            raw = json.dumps(block["input"]) if block["type"] == "tool_use" else block["text"]
            for offset in range(0, len(raw), 8):
                delta = {"type": "input_json_delta", "partial_json": raw[offset:offset+8]} if block["type"] == "tool_use" else {"type": "text_delta", "text": raw[offset:offset+8]}
                yield {"type": "content_block_delta", "index": index, "delta": delta}
            yield {"type": "content_block_stop", "index": index}
        yield {"type": "message_delta", "delta": {"stop_reason": native["stop_reason"]}, "usage": {"output_tokens": native["usage"]["output_tokens"]}}
        yield {"type": "message_stop"}
    else:
        def chunk(delta, finish=None):
            return {"model": response.get("model", "mock/planner"), "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
        yield chunk({"role": "assistant"})
        text = message.get("content") or ""
        for offset in range(0, len(text), 8):
            yield chunk({"content": text[offset:offset+8]})
        for index, tool in enumerate(message.get("tool_calls", [])):
            yield chunk({"tool_calls": [{"index": index, "id": tool["id"], "type": "function", "function": {"name": tool["function"]["name"], "arguments": ""}}]})
            args = tool["function"]["arguments"]
            for offset in range(0, len(args), 8):
                yield chunk({"tool_calls": [{"index": index, "function": {"arguments": args[offset:offset+8]}}]})
        yield chunk({}, "tool_calls" if message.get("tool_calls") else "stop")
        yield {"choices": [], "usage": response.get("usage", {})}
        yield "[DONE]"


def completion(text):
    return {"choices": [{"message": {"role": "assistant", "content": text}}], "usage": {"prompt_tokens": 5, "completion_tokens": 2, "cost": 0.000001}}


def content_text(value):
    if isinstance(value, str):
        return value
    return " ".join(p.get("text", "") for p in value if isinstance(p, dict)) if isinstance(value, list) else ""


CATALOG = [
    {"id": "mock/planner", "name": "Mock planner", "supported_parameters": ["tools", "temperature", "max_tokens"], "context_length": 128000,
     "architecture": {"input_modalities": ["text", "image"], "output_modalities": ["text"]}, "top_provider": {"max_completion_tokens": 8192},
     "pricing": {"prompt": "0.000001", "completion": "0.000002"}},
    {"id": "mock/retiring", "name": "Retiring fixture", "supported_parameters": ["tools"], "context_length": 64000,
     "architecture": {"input_modalities": ["text", "image"], "output_modalities": ["text"]}, "top_provider": {"max_completion_tokens": 4096},
     "pricing": {"prompt": "0.0000001", "completion": "0.0000002"}, "expiration_date": "2027-01-01"},
    {"id": "mock/weak", "name": "Weak eval fixture", "supported_parameters": ["tools"], "context_length": 64000,
     "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]}, "top_provider": {"max_completion_tokens": 4096}}
]


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
            self._send(200, {"data": CATALOG})
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
        selected_model = payload.get("model") or (payload.get("models") or ["mock/planner"])[0]
        systems = " ".join(content_text(m.get("content", "")) for m in messages if m.get("role") == "system")
        if "AI_GOLDEN_JUDGE" in systems:
            response = completion('{"score":1}')
        elif "AI_GOLDEN_CASE:" in systems:
            if selected_model == "mock/weak":
                response = completion("incorrect")
            elif "arithmetic" in systems:
                response = completion("4")
            elif "structured" in systems:
                response = completion('{"ok":true}')
            else:
                response = completion("I cannot share private information.")
        else:
            response = plan(messages)
        response["model"] = selected_model
        usage = response.setdefault("usage", {})
        cached = cached_usage(messages, usage.get("prompt_tokens", 0))
        usage["prompt_tokens_details"] = {"cached_tokens": cached}
        if payload.get("stream") is True:
            self._stream(response, path == "/anthropic/v1/messages")
        elif path == "/anthropic/v1/messages":
            converted = anthropic_response(response)
            converted["usage"]["cache_read_input_tokens"] = cached
            self._send(200, converted)
        else:
            self._send(200, response)

    def _stream(self, response: dict, anthropic: bool) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        delay = max(0, min(5000, int(os.environ.get("MOCK_STREAM_DELAY_MS", "20")))) / 1000
        first = max(0, min(10000, int(os.environ.get("MOCK_FIRST_TOKEN_DELAY_MS", os.environ.get("MOCK_STREAM_FIRST_TOKEN_DELAY_MS", "0"))))) / 1000
        try:
            time.sleep(first)
            for frame in stream_frames(response, anthropic):
                data = frame if isinstance(frame, str) else json.dumps(frame)
                event = f"event: {frame['type']}\n" if anthropic and isinstance(frame, dict) else ""
                self.wfile.write((event + "data: " + data + "\n\n").encode("utf-8"))
                self.wfile.flush()
                time.sleep(delay)
        except (BrokenPipeError, ConnectionResetError):
            pass
        self.close_connection = True

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
