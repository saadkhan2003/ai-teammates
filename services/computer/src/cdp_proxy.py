#!/usr/bin/env python3
"""Publish Chrome's localhost-only DevTools port to other containers.

Current Chromium builds ignore --remote-debugging-address and bind
127.0.0.1. They also reject a Host header that is not an IP address or
localhost, so the agent cannot open http://<container-name>:9222 directly.
This proxy listens on 0.0.0.0:9222, rewrites Host to the local Chrome
port, and rewrites debugger websocket URLs back to the caller's host.
"""
from __future__ import annotations

import os
import socket
import threading

LISTEN = int(os.environ.get("CDP_PROXY_PORT", "9222"))
BACKEND = int(os.environ.get("CDP_PORT", "9223"))


def main() -> None:
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("0.0.0.0", LISTEN))
    server.listen(64)
    while True:
        client, _addr = server.accept()
        threading.Thread(target=_handle, args=(client,), daemon=True).start()


def _handle(client: socket.socket) -> None:
    # Playwright fetches /json/version and then reuses that keep-alive
    # socket for the DevTools websocket. Closing after the first response
    # makes the upgrade fail with "socket hang up".
    upstream: socket.socket | None = None
    try:
        client.settimeout(30)
        buffered = b""
        while True:
            head, buffered = _read_until_buffered(client, buffered)
            if head is None:
                return
            caller = _host_of(head) or f"127.0.0.1:{LISTEN}"
            req_len = _content_length(head) or 0
            while len(buffered) < req_len:
                chunk = client.recv(8192)
                if not chunk:
                    return
                buffered += chunk
            req_body, buffered = buffered[:req_len], buffered[req_len:]
            upstream = socket.create_connection(("127.0.0.1", BACKEND), timeout=5)
            upstream.settimeout(30)
            upstream.sendall(_rewrite_host(head, f"127.0.0.1:{BACKEND}") + b"\r\n\r\n" + req_body)
            response, pending = _read_until(upstream, b"\r\n\r\n")
            if response is None:
                return
            if _is_upgrade(response):
                client.sendall(response + b"\r\n\r\n" + pending)
                if buffered:
                    upstream.sendall(buffered)
                client.settimeout(None)
                upstream.settimeout(None)
                _splice(client, upstream)
                upstream = None
                return
            body = _read_body(upstream, response, pending)
            upstream.close()
            upstream = None
            needle = f"127.0.0.1:{BACKEND}".encode()
            body = body.replace(needle, caller.encode())
            body = body.replace(f"localhost:{BACKEND}".encode(), caller.encode())
            client.sendall(_with_length(response, len(body)) + b"\r\n\r\n" + body)
            if _wants_close(head):
                return
    except Exception:
        pass
    finally:
        client.close()
        if upstream is not None:
            upstream.close()


def _read_until_buffered(sock: socket.socket, buffered: bytes) -> tuple[bytes | None, bytes]:
    data = buffered
    while b"\r\n\r\n" not in data:
        chunk = sock.recv(8192)
        if not chunk:
            return None, data
        data += chunk
        if len(data) > 1_000_000:
            return None, data
    head, pending = data.split(b"\r\n\r\n", 1)
    return head, pending


def _wants_close(head: bytes) -> bool:
    for line in head.split(b"\r\n"):
        if line.lower().startswith(b"connection:") and b"close" in line.lower():
            return True
    return False


def _host_of(head: bytes) -> str:
    for line in head.split(b"\r\n")[1:]:
        if line.lower().startswith(b"host:"):
            return line.split(b":", 1)[1].strip().decode("latin1")
    return ""


def _rewrite_host(head: bytes, host: str) -> bytes:
    lines = head.split(b"\r\n")
    found = False
    rewritten: list[bytes] = []
    for line in lines:
        if line.lower().startswith(b"host:"):
            rewritten.append(b"Host: " + host.encode())
            found = True
        else:
            rewritten.append(line)
    if not found:
        rewritten.insert(1, b"Host: " + host.encode())
    return b"\r\n".join(rewritten)


def _is_upgrade(head: bytes) -> bool:
    status = head.split(b"\r\n", 1)[0]
    if b" 101 " in status:
        return True
    return any(line.lower().startswith(b"upgrade:") for line in head.split(b"\r\n"))


def _with_length(head: bytes, length: int) -> bytes:
    lines = [
        line
        for line in head.split(b"\r\n")
        if not line.lower().startswith(b"transfer-encoding:") and not line.lower().startswith(b"content-length:")
    ]
    lines.append(f"Content-Length: {length}".encode())
    return b"\r\n".join(lines)


def _read_until(sock: socket.socket, marker: bytes) -> tuple[bytes | None, bytes]:
    data = b""
    while marker not in data:
        chunk = sock.recv(8192)
        if not chunk:
            return None, data
        data += chunk
        if len(data) > 1_000_000:
            return None, data
    head, pending = data.split(marker, 1)
    return head, pending


def _content_length(head: bytes) -> int | None:
    for line in head.split(b"\r\n"):
        if line.lower().startswith(b"content-length:"):
            try:
                return int(line.split(b":", 1)[1].strip())
            except ValueError:
                return None
    return None


def _read_body(sock: socket.socket, head: bytes, pending: bytes) -> bytes:
    length = _content_length(head)
    if length is not None:
        while len(pending) < length:
            chunk = sock.recv(8192)
            if not chunk:
                break
            pending += chunk
        return pending[:length]
    chunked = any(
        line.lower().startswith(b"transfer-encoding:") and b"chunked" in line.lower()
        for line in head.split(b"\r\n")
    )
    if chunked:
        return _read_chunked(sock, pending)
    chunks = [pending]
    try:
        while True:
            chunk = sock.recv(8192)
            if not chunk:
                break
            chunks.append(chunk)
    except OSError:
        pass
    return b"".join(chunks)


def _read_chunked(sock: socket.socket, pending: bytes) -> bytes:
    body = bytearray()
    data = pending
    while True:
        while b"\r\n" not in data:
            chunk = sock.recv(8192)
            if not chunk:
                return bytes(body)
            data += chunk
        line, data = data.split(b"\r\n", 1)
        size = int(line.split(b";", 1)[0] or b"0", 16)
        if size == 0:
            return bytes(body)
        while len(data) < size + 2:
            chunk = sock.recv(8192)
            if not chunk:
                return bytes(body)
            data += chunk
        body += data[:size]
        data = data[size + 2 :]


def _splice(client: socket.socket, upstream: socket.socket) -> None:
    def pump(src: socket.socket, dst: socket.socket) -> None:
        try:
            while True:
                data = src.recv(65536)
                if not data:
                    break
                dst.sendall(data)
        except OSError:
            pass
        finally:
            try:
                dst.shutdown(socket.SHUT_WR)
            except OSError:
                pass

    thread = threading.Thread(target=pump, args=(upstream, client), daemon=True)
    thread.start()
    pump(client, upstream)
    thread.join(2)


if __name__ == "__main__":
    main()
