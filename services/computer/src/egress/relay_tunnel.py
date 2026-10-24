"""Multiplexed computer-to-companion TCP tunnel over the authenticated API relay."""
from __future__ import annotations

import asyncio
import json
import os
from urllib.parse import quote, urlsplit, urlunsplit

from egress.relay import RouteState


class RelayStream:
    def __init__(self, manager, stream_id):
        self.manager = manager
        self.stream_id = stream_id
        self.queue = asyncio.Queue()
        self.reader = self
        self.writer = self
        self.closed = False
        self.buffered = []

    async def read(self, size=65536):
        block = await self.queue.get()
        return block[:size]

    def write(self, data):
        if not self.closed:
            self.buffered.append(bytes(data))

    async def drain(self):
        while self.buffered:
            block = self.buffered.pop(0)
            await self.manager.send(self.stream_id.to_bytes(4, "big") + block)

    def write_eof(self):
        self.close()

    def close(self):
        if not self.closed:
            self.closed = True
            asyncio.create_task(self.manager.send_json({"type": "close", "id": self.stream_id}))
            self.manager.streams.pop(self.stream_id, None)

    async def wait_closed(self):
        return None

    def feed(self, data):
        self.queue.put_nowait(data)


class RelayTunnelManager:
    def __init__(self, *, api_url=None, computer_id=None, token=None, route_state=None, connector=None):
        self.api_url = api_url or os.environ.get("EGRESS_API_URL", "http://api:8080")
        self.computer_id = computer_id or os.environ.get("COMPUTER_ID", "")
        self.token = token or os.environ.get("COMPUTER_TOKEN", "")
        self.route_state = route_state or RouteState()
        self.connector = connector
        self.websocket = None
        self.streams = {}
        self.pending = {}
        self.next_id = 0
        self.send_lock = asyncio.Lock()

    @property
    def url(self):
        parts = urlsplit(self.api_url)
        scheme = "wss" if parts.scheme == "https" else "ws"
        path = parts.path.rstrip("/") + "/api/egress/relay/" + quote(self.computer_id, safe="")
        return urlunsplit((scheme, parts.netloc, path, "role=computer", ""))

    async def run(self):
        if self.connector is None:
            from websockets.asyncio.client import connect
            # Never route the tunnel through the container's own egress proxy (HTTP(S)_PROXY).
            self.connector = lambda *args, **kwargs: connect(*args, proxy=None, **kwargs)
        while True:
            try:
                async with self.connector(self.url, additional_headers={"Authorization": "Bearer " + self.token}, open_timeout=15, close_timeout=5) as ws:
                    self.websocket = ws
                    # The API sends {"type":"ready"} once a desktop companion is paired; only then is the desktop the route.
                    await self._read_loop(ws)
            except asyncio.CancelledError:
                raise
            except (OSError, TimeoutError, RuntimeError):
                pass
            finally:
                self.websocket = None
                self.route_state.dropped()
                for queue in self.pending.values():
                    if not queue.full(): queue.put_nowait({"type": "error", "reason": "relay disconnected"})
                self.pending.clear()
                for stream in tuple(self.streams.values()):
                    stream.feed(b"")
                self.streams.clear()
            await asyncio.sleep(1)

    async def _read_loop(self, ws):
        async for frame in ws:
            if isinstance(frame, bytes):
                if len(frame) >= 4:
                    stream = self.streams.get(int.from_bytes(frame[:4], "big"))
                    if stream: stream.feed(frame[4:])
                continue
            try: msg = json.loads(frame)
            except (ValueError, TypeError): continue
            if isinstance(msg, dict) and msg.get("type") == "ready":
                self.route_state.attached()
                continue
            stream_id = msg.get("id")
            if not isinstance(stream_id, int): continue
            pending = self.pending.get(stream_id)
            if pending is not None:
                pending.put_nowait(msg)
            elif msg.get("type") == "close" and stream_id in self.streams:
                self.streams[stream_id].feed(b"")

    async def send(self, frame):
        ws = self.websocket
        if ws is None:
            raise ConnectionError("egress relay unavailable")
        async with self.send_lock:
            await ws.send(frame)

    async def send_json(self, message):
        ws = self.websocket
        if ws is None: return
        async with self.send_lock:
            await ws.send(json.dumps(message, separators=(",", ":")))

    async def open(self, host, port):
        if self.websocket is None:
            raise ConnectionError("egress relay unavailable")
        self.next_id = self.next_id % (2**32 - 1) + 1
        stream_id = self.next_id
        queue = asyncio.Queue(maxsize=2)
        self.pending[stream_id] = queue
        await self.send_json({"type": "connect", "id": stream_id, "host": host, "port": port})
        try:
            response = await asyncio.wait_for(queue.get(), timeout=15)
        finally:
            self.pending.pop(stream_id, None)
        if response.get("type") != "connected":
            raise ConnectionError("desktop egress destination refused")
        stream = RelayStream(self, stream_id)
        self.streams[stream_id] = stream
        return stream.reader, stream.writer
