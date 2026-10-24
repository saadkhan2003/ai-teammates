"""Ticketed, per-window terminal WebSocket service using only the Python stdlib."""
from __future__ import annotations

import asyncio
import base64
import fcntl
import hashlib
import hmac
import json
import os
import struct
import subprocess
import termios
import time
import tty
from typing import Protocol

from box_contract import MAX_WINDOWS, port_for
from tickets import TicketError, TicketStore

MAX_FRAME = 64 * 1024


class Transport(Protocol):
    async def receive(self) -> str | bytes | None: ...
    async def send(self, value: str | bytes) -> None: ...
    async def close(self) -> None: ...


class PtySession:
    """A live PTY has no idle timeout; tmux owns the shell across reconnects."""

    def __init__(self, window: int, process_factory=None):
        if not 1 <= window <= MAX_WINDOWS:
            raise ValueError("invalid window")
        self.window = window
        self.process_factory = process_factory or self._spawn
        self.process = None
        self.master: int | None = None
        self.last_activity = time.monotonic()

    @staticmethod
    def _spawn(window: int, master: int, slave: int):
        session = f"box-{window}"
        if shutil_which("tmux"):
            subprocess.run(["tmux", "new-session", "-A", "-d", "-s", session], check=False, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3)
            argv = ["tmux", "attach-session", "-t", session]
        else:
            argv = [os.environ.get("SHELL", "/bin/bash")]

        def controlling_tty():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)

        env = dict(os.environ, TERM="xterm-256color")
        return subprocess.Popen(argv, stdin=slave, stdout=slave, stderr=slave, close_fds=True, preexec_fn=controlling_tty, env=env)

    def start(self):
        master, slave = os.openpty()
        tty.setraw(slave)
        self.master = master
        try:
            self.process = self.process_factory(self.window, master, slave)
        finally:
            os.close(slave)
        return master

    def is_alive(self, now: float | None = None) -> bool:
        del now
        return self.process is None or self.process.poll() is None

    def resize(self, rows: int, cols: int):
        if not (1 <= rows <= 500 and 1 <= cols <= 500):
            raise ValueError("invalid terminal size")
        if self.master is not None:
            fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def close_client(self):
        if self.master is not None:
            os.close(self.master)
            self.master = None
        # The tmux server and session intentionally remain alive after detach.


def shutil_which(name: str) -> str | None:
    for folder in os.environ.get("PATH", "").split(os.pathsep):
        candidate = os.path.join(folder, name)
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


class WebSocketTransport:
    """Small RFC6455 server-side transport: masked inbound frames, binary PTY data."""

    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        self.reader, self.writer = reader, writer
        self._send_lock = asyncio.Lock()

    @classmethod
    async def handshake(cls, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> tuple[WebSocketTransport, str] | None:
        header = await reader.readuntil(b"\r\n\r\n")
        if len(header) > 16 * 1024:
            return None
        rows = header.decode("latin1").split("\r\n")
        if rows[0] != "GET / HTTP/1.1":
            return None
        headers = {}
        for row in rows[1:]:
            if ":" in row:
                key, value = row.split(":", 1)
                headers[key.strip().lower()] = value.strip()
        if "origin" in headers:
            return None
        key = headers.get("sec-websocket-key", "")
        if (headers.get("upgrade", "").lower() != "websocket" or
                "upgrade" not in {part.strip().lower() for part in headers.get("connection", "").split(",")} or
                headers.get("sec-websocket-version") != "13" or not key):
            return None
        try:
            if len(base64.b64decode(key, validate=True)) != 16:
                return None
        except ValueError:
            return None
        protocols = [p.strip() for p in headers.get("sec-websocket-protocol", "").split(",") if p.strip()]
        ticket_protocol = next((p for p in protocols if p.startswith("terminal-ticket.")), "")
        if not ticket_protocol:
            return None
        digest = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        writer.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + digest + "\r\nSec-WebSocket-Protocol: " + ticket_protocol + "\r\n\r\n").encode("ascii"))
        await writer.drain()
        return cls(reader, writer), ticket_protocol.removeprefix("terminal-ticket.")

    async def receive(self) -> str | bytes | None:
        try:
            message_opcode: int | None = None
            message = bytearray()
            while True:
                first, second = await self.reader.readexactly(2)
                final, rsv, opcode, masked, size = bool(first & 128), first & 112, first & 15, bool(second & 128), second & 127
                if rsv or not masked:
                    raise ValueError("invalid client frame")
                if size == 126:
                    size = struct.unpack("!H", await self.reader.readexactly(2))[0]
                elif size == 127:
                    size = struct.unpack("!Q", await self.reader.readexactly(8))[0]
                if size > MAX_FRAME or (opcode >= 8 and (not final or size > 125)):
                    raise ValueError("frame too large")
                mask = await self.reader.readexactly(4)
                data = bytearray(await self.reader.readexactly(size))
                for i in range(size):
                    data[i] ^= mask[i % 4]
                if opcode == 8:
                    return None
                if opcode == 9:
                    await self._frame(10, bytes(data))
                    continue
                if opcode == 10:
                    continue
                if opcode in (1, 2):
                    if message_opcode is not None:
                        raise ValueError("interleaved websocket messages")
                    message_opcode = opcode
                elif opcode != 0 or message_opcode is None:
                    raise ValueError("invalid websocket continuation")
                message.extend(data)
                if len(message) > MAX_FRAME:
                    raise ValueError("message too large")
                if final:
                    if message_opcode == 2:
                        return bytes(message)
                    if message_opcode == 1:
                        return message.decode("utf-8")
                    raise ValueError("invalid websocket message")
        except (asyncio.IncompleteReadError, ConnectionError):
            return None

    async def _frame(self, opcode: int, data: bytes):
        if len(data) > MAX_FRAME:
            raise ValueError("frame too large")
        prefix = bytes([128 | opcode])
        if len(data) < 126:
            header = prefix + bytes([len(data)])
        else:
            header = prefix + bytes([126]) + struct.pack("!H", len(data))
        async with self._send_lock:
            self.writer.write(header + data)
            await self.writer.drain()

    async def send(self, value: str | bytes):
        if isinstance(value, str):
            await self._frame(1, value.encode("utf-8"))
        else:
            await self._frame(2, value)

    async def close(self):
        try:
            await self._frame(8, b"")
        except (ConnectionError, RuntimeError):
            pass
        self.writer.close()


class PtyServer:
    def __init__(self, secret: bytes, computer: str, window: int, *, session_factory=PtySession):
        self.tickets = TicketStore(secret)
        self.computer = computer
        self.window = window
        self.session_factory = session_factory

    async def handle_transport(self, transport: Transport, token: str):
        try:
            claims = self.tickets.verify(token)
            self.tickets.consume(token, claims["user"], claims["bot"], self.window, claims["role"], computer=self.computer)
        except TicketError:
            await transport.close()
            return False

        session = self.session_factory(self.window)
        master = session.start()
        loop = asyncio.get_running_loop()
        output: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=32)

        def readable():
            try:
                output.put_nowait(os.read(master, MAX_FRAME))
            except (OSError, asyncio.QueueFull):
                try:
                    output.put_nowait(None)
                except asyncio.QueueFull:
                    pass

        loop.add_reader(master, readable)
        async def terminal_output():
            while True:
                data = await output.get()
                if data is None:
                    return
                if data:
                    await transport.send(data)

        output_task = asyncio.create_task(terminal_output())
        try:
            while session.is_alive():
                message = await transport.receive()
                if message is None:
                    break
                session.last_activity = time.monotonic()
                if isinstance(message, bytes):
                    if len(message) > MAX_FRAME:
                        break
                    os.write(master, message)
                else:
                    try:
                        control = json.loads(message)
                        if set(control) != {"type", "cols", "rows"} or control["type"] != "resize":
                            continue
                        session.resize(int(control["rows"]), int(control["cols"]))
                    except (ValueError, TypeError, KeyError, json.JSONDecodeError):
                        continue
        finally:
            loop.remove_reader(master)
            output_task.cancel()
            session.close_client()
            await transport.close()
        return True

    async def listen(self, host: str = "0.0.0.0"):
        async def connection(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
            try:
                result = await WebSocketTransport.handshake(reader, writer)
                if result is None:
                    writer.close()
                    return
                transport, token = result
                await self.handle_transport(transport, token)
            except (ValueError, asyncio.IncompleteReadError, asyncio.LimitOverrunError, ConnectionError):
                writer.close()
        return await asyncio.start_server(connection, host, port_for("pty", self.window), limit=MAX_FRAME + 32)


async def serve_all():
    secret = os.environ.get("COMPUTER_TOKEN", "").encode()
    computer = os.environ.get("COMPUTER_ID", "")
    if len(secret) < 32 or not computer:
        raise RuntimeError("terminal ticket configuration is missing")
    per_computer_secret = hashlib.sha256(secret + b":" + computer.encode("utf-8")).digest()
    servers = [await PtyServer(per_computer_secret, computer, window).listen() for window in range(1, MAX_WINDOWS + 1)]
    async with asyncio.TaskGroup() as group:
        for server in servers:
            group.create_task(server.serve_forever())


if __name__ == "__main__":
    asyncio.run(serve_all())
