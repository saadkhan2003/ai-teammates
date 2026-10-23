"""Owner-token gate and window-to-exec-port mapping for the internal router."""
from __future__ import annotations

import hmac
import http.client
import os
import secrets
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable, Any

from box_contract import MAX_WINDOWS, PATHS, WINDOW_ROUTER, port_for


def upstream_port(display: int) -> int:
    return port_for("exec", display)


def new_owner_token() -> str:
    return secrets.token_urlsafe(32)


def write_owner_token(token_dir: Path, display: int, token: str) -> Path:
    if isinstance(display, bool) or not 1 <= display <= MAX_WINDOWS:
        raise ValueError("invalid display")
    if not isinstance(token, str) or not 16 <= len(token) <= 512 or "\n" in token:
        raise ValueError("invalid owner token")
    root = Path(token_dir)
    if root.is_symlink():
        raise ValueError("unsafe token directory")
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(root, 0o700)
    root = root.resolve(strict=True)
    path = root / str(display)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{display}.", dir=root)
    tmp = Path(tmp_name)
    with os.fdopen(fd, "w") as stream:
        stream.write(token)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    return path


class WindowRouter:
    def __init__(self, token_dir: Path | None = None, *, upstream: Callable[[int], Any],
                 marker_dir: Path | None = None, clock: Callable[[], float] = time.time):
        self.token_dir = Path(token_dir or PATHS["windowTokens"])
        self.marker_dir = Path(marker_dir or PATHS["windowUsed"])
        self.upstream, self.clock = upstream, clock

    def heartbeat(self) -> None:
        try:
            if self.token_dir.is_symlink():
                raise OSError("unsafe token directory")
            root = self.token_dir.resolve(strict=True)
            displays = [path.name for path in root.iterdir()
                        if path.name.isascii() and path.name.isdecimal() and
                        1 <= int(path.name) <= MAX_WINDOWS and not path.is_symlink()]
        except OSError:
            return
        self.marker_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        for display in displays:
            marker = self.marker_dir / display
            try:
                fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
                os.close(fd)
                now = self.clock()
                os.utime(marker, (now, now), follow_symlinks=False)
            except OSError:
                continue

    def handle(self, display: str, owner_token: str | None) -> tuple[int, Any]:
        if not isinstance(display, str) or not display.isascii() or not display.isdecimal():
            return 404, None
        window = int(display)
        if not 1 <= window <= MAX_WINDOWS:
            return 404, None
        token = owner_token if isinstance(owner_token, str) else ""
        if len(token) > 512:
            token = token[:512]
            valid = False
        else:
            valid = True
        try:
            if self.token_dir.is_symlink():
                return
            root = self.token_dir.resolve(strict=True)
            target = root / display
            if target.is_symlink() or target.resolve(strict=True).parent != root:
                raise OSError("unsafe token file")
            fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd, "rb") as stream:
                expected_bytes = stream.read(513)
            if len(expected_bytes) > 512:
                raise OSError("oversized token")
        except OSError:
            expected_bytes = b""
            valid = False
        # Compare same-length buffers so mismatch position does not affect the comparison.
        token_bytes = token.encode("utf-8", "ignore")
        if len(token_bytes) > 512:
            token_bytes = token_bytes[:512]
            valid = False
        matched = hmac.compare_digest(token_bytes.ljust(512, b"\0"), expected_bytes.ljust(512, b"\0"))
        same_length = len(token_bytes) == len(expected_bytes)
        if not (valid and expected_bytes and same_length and matched):
            return 403, None
        port = upstream_port(window)
        result = self.upstream(port)
        self.marker_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        marker = self.marker_dir / display
        fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        os.close(fd)
        os.utime(marker, (self.clock(), self.clock()))
        return 200, result


def serve() -> None:
    token_dir = Path(PATHS["windowTokens"])
    marker_dir = Path(PATHS["windowUsed"])

    def forward(port: int, method: str, path: str, body: bytes, headers: dict[str, str]):
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        try:
            conn.request(method, path, body=body, headers=headers)
            response = conn.getresponse()
            return response.status, response.getheaders(), response.read(1_000_001)
        finally:
            conn.close()

    # The callable gate validates authorization before this forwarding function runs.
    router = WindowRouter(token_dir, upstream=lambda port: port, marker_dir=marker_dir)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            return

        def do_GET(self): self._dispatch()
        def do_POST(self): self._dispatch()
        def do_PUT(self): self._dispatch()
        def do_DELETE(self): self._dispatch()

        def _dispatch(self):
            raw_length = self.headers.get("Content-Length", "0")
            if not raw_length.isascii() or not raw_length.isdecimal() or int(raw_length) > 1_000_000:
                self.send_error(413)
                return
            status, port = router.handle(self.headers.get("X-Display", ""), self.headers.get("X-Window-Owner"))
            if status != 200:
                self.send_response(status)
                self.end_headers()
                return
            excluded = {"host", "content-length", "x-display", "x-window-owner", "connection"}
            headers = {key: value for key, value in self.headers.items() if key.lower() not in excluded}
            try:
                code, response_headers, body = forward(port, self.command, self.path,
                                                       self.rfile.read(int(raw_length)), headers)
                self.send_response(code)
                for key, value in response_headers:
                    if key.lower() not in {"transfer-encoding", "connection", "content-length"}:
                        self.send_header(key, value)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except OSError:
                self.send_error(502)

    import threading

    def keep_alive():
        while True:
            router.heartbeat()
            time.sleep(15)

    threading.Thread(target=keep_alive, name="window-marker", daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", WINDOW_ROUTER), Handler).serve_forever()


if __name__ == "__main__":
    serve()
