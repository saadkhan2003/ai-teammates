"""Tiny fixture site on :8099. Host decides the browser origin; files are shared."""
from __future__ import annotations

import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path("/opt/fixtures/www")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        return

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/go-evil":
            self.send_response(302)
            self.send_header("Location", "http://evil.example:8099/phish.html")
            self.end_headers()
            return
        rel = parsed.path.lstrip("/") or "desktop.html"
        path = (ROOT / rel).resolve()
        if ROOT.resolve() not in path.parents and path != ROOT.resolve():
            self.send_error(404)
            return
        if not path.is_file():
            self.send_error(404)
            return
        data = path.read_bytes()
        self.send_response(200)
        if path.suffix == ".html":
            self.send_header("Content-Type", "text/html; charset=utf-8")
        else:
            self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def start() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 8099), Handler)
    thread = threading.Thread(target=server.serve_forever, name="fixtures", daemon=True)
    thread.start()
