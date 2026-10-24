"""OpenRouter-shaped HTTP stub. Logs message counts only."""
from __future__ import annotations

import hashlib
import json
import os
from collections import OrderedDict
from threading import Lock
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


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:
        return

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        token = authorized(self.headers.get("Authorization", ""))
        if token is None:
            self._send(401, {"error": "unauthorized"})
            return
        if path == "/api/v1/key":
            self._send(200, {"data": {"limit_remaining": limit_remaining(token)}})
            return
        self._send(404, {"error": "not_found"})

    def do_POST(self) -> None:
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        token = authorized(self.headers.get("Authorization", ""))
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length else b""
        if token is None:
            self._send(401, {"error": "unauthorized"})
            return
        if path == "/api/v1/audio/transcriptions":
            try:
                payload = json.loads(raw.decode("utf-8") if raw else "{}")
            except json.JSONDecodeError:
                self._send(400, {"error": "invalid json"})
                return
            provider = (payload.get("provider") or {}).get("order", ["mock"])[0]
            self._send(200, {"text": "Mock transcription.", "segments": [{"start": 0, "end": 1, "text": "Mock transcription."}], "provider": provider})
            return
        if path != "/api/v1/chat/completions":
            self._send(404, {"error": "not_found"})
            return
        try:
            payload = json.loads(raw.decode("utf-8") if raw else "{}")
        except json.JSONDecodeError:
            self._send(400, {"error": "invalid json"})
            return
        messages = payload.get("messages") if isinstance(payload, dict) else None
        if not isinstance(messages, list):
            messages = []
        print(f"messages={len(messages)}", flush=True)
        result = plan(messages)
        usage = result.setdefault("usage", {})
        usage["prompt_tokens_details"] = {"cached_tokens": cached_usage(messages, usage.get("prompt_tokens", 0))}
        self._send(200, result)

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
