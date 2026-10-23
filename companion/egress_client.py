"""Authenticated companion egress attach with a bounded reconnect grace period."""
from __future__ import annotations

import asyncio
import ipaddress
import json
import socket
import time
from urllib.parse import quote, urlsplit, urlunsplit

RECONNECT_GRACE_SECONDS = 90


def _public_address(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    return address.is_global


async def _connect_public(host: str, port: int):
    """Resolve once on the companion and connect only to checked public addresses."""
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    if not infos or any(not _public_address(item[4][0]) for item in infos):
        raise PermissionError("destination address is blocked")
    last_error = None
    for family, socktype, proto, _, sockaddr in infos:
        sock = socket.socket(family, socktype, proto)
        sock.setblocking(False)
        try:
            await loop.sock_connect(sock, sockaddr)
            return await asyncio.open_connection(sock=sock)
        except OSError as exc:
            last_error = exc
            sock.close()
    if last_error:
        raise last_error
    raise OSError("destination unavailable")


class EgressClient:
    def __init__(self, server: str, device_id: str, token: str, *, fail_closed: bool, clock=time.monotonic, connector=None):
        parts = urlsplit(server)
        if parts.scheme not in {"http", "https", "ws", "wss"} or not parts.netloc:
            raise ValueError("server must be an http(s) URL")
        self.server = urlunsplit(("wss" if parts.scheme in {"https", "wss"} else "ws", parts.netloc, parts.path.rstrip("/") + f"/api/egress/relay/{quote(device_id, safe='')}", "role=companion&deviceId=" + quote(device_id), ""))
        self.token = token
        self.fail_closed = bool(fail_closed)
        self.clock = clock
        self.connector = connector
        self.last_attached = clock()

    def route_available(self) -> bool:
        return self.clock() - self.last_attached <= RECONNECT_GRACE_SECONDS

    async def run(self):
        if self.connector is None:
            try:
                from websockets.asyncio.client import connect
            except ImportError as exc:
                raise RuntimeError("install the websockets package to use egress-client") from exc
            self.connector = connect
        while True:
            try:
                async with self.connector(self.server, additional_headers={"Authorization": "Bearer " + self.token}, open_timeout=15, close_timeout=5) as ws:
                    self.last_attached = self.clock()
                    await self._splice(ws)
            except (OSError, TimeoutError):
                if not self.route_available() and self.fail_closed:
                    raise RuntimeError("egress route unavailable (fail-closed)")
                await asyncio.sleep(1)

    async def _splice(self, ws):
        """Handle multiplexed CONNECT frames: JSON open/close, binary id+TCP bytes."""
        streams = {}
        pumps = set()
        send_lock = asyncio.Lock()

        async def send(frame):
            async with send_lock:
                await ws.send(frame)

        async def pump(stream_id, reader):
            try:
                while block := await reader.read(65532):
                    await send(stream_id.to_bytes(4, "big") + block)
            except (OSError, ConnectionError):
                pass
            finally:
                await send(json.dumps({"type": "close", "id": stream_id}))

        try:
            async for frame in ws:
                if isinstance(frame, str):
                    try:
                        message = json.loads(frame)
                    except (ValueError, TypeError):
                        continue
                    stream_id = message.get("id")
                    if not isinstance(stream_id, int) or not 0 < stream_id < 2**32:
                        continue
                    if message.get("type") == "close":
                        pair = streams.pop(stream_id, None)
                        if pair:
                            pair[1].close()
                        continue
                    if message.get("type") != "connect":
                        continue
                    host, port = message.get("host"), message.get("port")
                    if not isinstance(host, str) or len(host) > 253 or not isinstance(port, int) or not 1 <= port <= 65535:
                        await send(json.dumps({"type": "error", "id": stream_id, "reason": "invalid destination"}))
                        continue
                    try:
                        reader, writer = await asyncio.wait_for(_connect_public(host, port), timeout=10)
                    except (OSError, TimeoutError, PermissionError):
                        await send(json.dumps({"type": "error", "id": stream_id, "reason": "destination address is blocked or unavailable"}))
                        continue
                    streams[stream_id] = (reader, writer)
                    await send(json.dumps({"type": "connected", "id": stream_id}))
                    task = asyncio.create_task(pump(stream_id, reader))
                    pumps.add(task)
                    task.add_done_callback(pumps.discard)
                elif isinstance(frame, bytes) and len(frame) >= 4:
                    stream_id = int.from_bytes(frame[:4], "big")
                    pair = streams.get(stream_id)
                    if pair:
                        pair[1].write(frame[4:])
                        await pair[1].drain()
        finally:
            for _, writer in streams.values():
                writer.close()
            if pumps:
                await asyncio.gather(*pumps, return_exceptions=True)
