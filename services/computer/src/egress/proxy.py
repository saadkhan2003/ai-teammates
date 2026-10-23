"""Small loopback CONNECT proxy with DNS pinning, policy checks, and safe audit lines."""
from __future__ import annotations

import asyncio
import hmac
import ipaddress
import json
import os
import re
import socket
import time
from pathlib import Path
from urllib.parse import urlsplit

import box_contract
from egress.policy import NetworkPolicy, PolicyFile
from egress.ssrf import is_blocked_ip, resolve_public

MAX_HEADER = 16_384
_AUTH_TOKEN = re.compile(r"^[A-Za-z0-9_-]{22,256}$")


def valid_attach_token(expected: str, presented: str) -> bool:
    """Compare attach credentials in constant time; credentials are never logged."""
    return bool(expected and presented and hmac.compare_digest(expected.encode(), presented.encode()))


def _audit(event: str, host: str, port: int, allowed: bool, reason: str = "") -> None:
    path = os.environ.get("EGRESS_AUDIT_PATH", "/tmp/egress-audit.jsonl")
    # Host is bounded and control characters are rejected before reaching here.
    record = {"ts": int(time.time()), "event": event, "host": host[:253], "port": port,
              "allowed": allowed, "reason": reason[:120]}
    try:
        fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as stream:
            stream.write(json.dumps(record, separators=(",", ":")) + "\n")
    except OSError:
        pass


def _parse_authority(value: str) -> tuple[str, int]:
    if len(value) > 1024 or any(ord(c) < 33 or ord(c) == 127 for c in value) or "@" in value:
        raise ValueError("invalid CONNECT authority")
    if value.startswith("["):
        close = value.find("]")
        if close < 0 or close + 1 >= len(value) or value[close + 1] != ":":
            raise ValueError("invalid CONNECT authority")
        host, raw_port = value[1:close], value[close + 2:]
    else:
        if value.count(":") != 1:
            raise ValueError("invalid CONNECT authority")
        host, raw_port = value.rsplit(":", 1)
    if not raw_port.isdecimal() or not host:
        raise ValueError("invalid CONNECT authority")
    port = int(raw_port)
    if not 1 <= port <= 65535:
        raise ValueError("invalid CONNECT authority")
    return host, port


async def _copy(reader, writer):
    try:
        while block := await reader.read(65536):
            writer.write(block)
            await writer.drain()
    except (ConnectionError, asyncio.CancelledError):
        pass
    finally:
        try:
            writer.write_eof()
        except (AttributeError, OSError):
            pass


class ConnectProxy:
    def __init__(self, policy=None, fail_closed_path=None):
        self.policy = policy or NetworkPolicy()
        self.policy_file = PolicyFile(os.environ.get("EGRESS_POLICY_FILE", "/run/egress/policy.json"))
        self.fail_closed_path = Path(fail_closed_path or box_contract.PATHS["egressFailClosed"])

    async def handle(self, client_reader, client_writer):
        peer = client_writer.get_extra_info("peername")
        if not peer or peer[0] not in {"127.0.0.1", "::1"}:
            client_writer.close()
            return
        try:
            header = await asyncio.wait_for(client_reader.readuntil(b"\r\n\r\n"), timeout=10)
            if len(header) > MAX_HEADER:
                raise ValueError("header too large")
            if any(byte < 32 and byte not in (9, 10, 13) or byte == 127 for byte in header):
                raise ValueError("invalid header")
            lines = header.decode("latin-1").split("\r\n")
            parts = lines[0].split()
            if len(parts) != 3 or parts[2] not in {"HTTP/1.0", "HTTP/1.1"}:
                await self._reply(client_writer, 400, "invalid proxy request")
                return
            is_connect = parts[0].upper() == "CONNECT"
            if is_connect:
                host, port = _parse_authority(parts[1])
                forward_header = None
            else:
                target = urlsplit(parts[1])
                if target.scheme.lower() != "http" or not target.hostname or target.username or target.password or target.fragment:
                    await self._reply(client_writer, 400, "absolute HTTP URL required")
                    return
                host, port = target.hostname, target.port or 80
                path = target.path or "/"
                if target.query:
                    path += "?" + target.query
                safe_headers = [line for line in lines[1:] if line and not line.lower().startswith(("host:", "proxy-authorization:", "proxy-connection:", "connection:"))]
                authority = f"[{host}]" if ":" in host else host
                if port != 80:
                    authority += f":{port}"
                safe_headers.extend([f"Host: {authority}", "Connection: close"])
                forward_header = (f"{parts[0]} {path} {parts[2]}\r\n" + "\r\n".join(safe_headers) + "\r\n\r\n").encode("latin-1")
            policy = self.policy_file.current() if self.policy_file.path.exists() else self.policy
            if not policy.allows(host, port):
                _audit("connect", host, port, False, policy.block_reason(host))
                await self._reply(client_writer, 403, policy.block_reason(host))
                return
            if self.fail_closed_path.exists():
                _audit("connect", host, port, False, "desktop route unavailable")
                await self._reply(client_writer, 503, "egress route unavailable")
                return
            try:
                addresses = await resolve_public(host, port)
            except (ValueError, PermissionError, OSError):
                _audit("connect", host, port, False, "destination address is blocked")
                await self._reply(client_writer, 403, "destination address is blocked")
                return
            upstream_reader = upstream_writer = None
            for family, socktype, proto, _, sockaddr in addresses:
                # Do not resolve the hostname a second time during connect.
                sock = socket.socket(family, socktype, proto)
                sock.setblocking(False)
                try:
                    await asyncio.get_running_loop().sock_connect(sock, sockaddr)
                    upstream_reader, upstream_writer = await asyncio.open_connection(sock=sock)
                    break
                except OSError:
                    sock.close()
            if upstream_writer is None:
                await self._reply(client_writer, 502, "upstream unavailable")
                return
            _audit("connect", host, port, True)
            client_writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n" if is_connect else forward_header)
            await client_writer.drain()
            await asyncio.gather(_copy(client_reader, upstream_writer), _copy(upstream_reader, client_writer))
            upstream_writer.close()
            await upstream_writer.wait_closed()
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, TimeoutError, UnicodeError, ValueError):
            await self._reply(client_writer, 400, "invalid CONNECT request")
        finally:
            client_writer.close()
            try:
                await client_writer.wait_closed()
            except OSError:
                pass

    @staticmethod
    async def _reply(writer, code: int, message: str):
        safe = message.replace("\r", " ").replace("\n", " ")[:300]
        body = (safe + "\n").encode()
        writer.write(f"HTTP/1.1 {code} {safe}\r\nConnection: close\r\nContent-Length: {len(body)}\r\n\r\n".encode() + body)
        await writer.drain()


async def serve():
    import logging
    logging.basicConfig(level=logging.INFO)
    proxy = ConnectProxy()
    server = await asyncio.start_server(proxy.handle, "127.0.0.1", box_contract.EGRESS_PROXY, limit=MAX_HEADER)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(serve())
