"""Authenticated companion egress attach with a bounded reconnect grace period."""
from __future__ import annotations

import asyncio
import json
import time
from urllib.parse import quote, urlsplit, urlunsplit

RECONNECT_GRACE_SECONDS = 90


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

        async def pump(stream_id, reader):
            try:
                while block := await reader.read(65532):
                    await ws.send(stream_id.to_bytes(4, "big") + block)
            except (OSError, ConnectionError):
                pass
            finally:
                await ws.send(json.dumps({"type": "close", "id": stream_id}))

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
                        await ws.send(json.dumps({"type": "error", "id": stream_id, "reason": "invalid destination"}))
                        continue
                    try:
                        reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout=10)
                    except (OSError, TimeoutError):
                        await ws.send(json.dumps({"type": "error", "id": stream_id, "reason": "desktop connect failed"}))
                        continue
                    streams[stream_id] = (reader, writer)
                    await ws.send(json.dumps({"type": "connected", "id": stream_id}))
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
