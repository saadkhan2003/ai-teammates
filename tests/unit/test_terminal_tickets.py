"""Terminal tickets are short lived, bound, and consumed once."""
import sys
import shutil
import subprocess
import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services/computer/src"))

from tickets import TicketError, TicketStore


def _pty_module():
    spec = importlib.util.spec_from_file_location("computer_terminal_pty_tests", ROOT / "services/computer/src/pty.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_ticket_is_single_use_and_bound_to_window():
    store = TicketStore(b"x" * 32)
    token = store.issue("user", "bot", 2, "user", now=100)
    assert store.consume(token, "user", "bot", 2, "user", now=101)
    with pytest.raises(TicketError):
        store.consume(token, "user", "bot", 2, "user", now=101)

    other = store.issue("user", "bot", 2, "user", now=100)
    with pytest.raises(TicketError):
        store.consume(other, "user", "bot", 3, "user", now=101)


def test_ticket_expiry_and_tampering_rejected():
    store = TicketStore(b"x" * 32)
    token = store.issue("user", "bot", 1, "user", now=100, ttl=60)
    with pytest.raises(TicketError):
        store.consume(token, "user", "bot", 1, "user", now=160)
    with pytest.raises(TicketError):
        store.consume(token[:-1] + ("A" if token[-1] != "A" else "B"), "user", "bot", 1, "user", now=101)


def test_ticket_nonce_is_128_bit_and_store_does_not_keep_raw_tokens():
    store = TicketStore(b"x" * 32)
    token = store.issue("user", "bot", 1, "user", now=100)
    claims = store.verify(token, now=101)
    assert len(claims["nonce"]) >= 22
    store.consume(token, "user", "bot", 1, "user", now=101)
    assert token not in store._consumed
    assert len(next(iter(store._consumed))) == 64


def test_idle_session_has_no_idle_timeout():
    class FakeProcess:
        returncode = None
        def poll(self):
            return self.returncode

    session = _pty_module().PtySession(1, process_factory=lambda *_: FakeProcess())
    session.start()
    session.last_activity = 0
    assert session.is_alive(now=301)
    session.close_client()


@pytest.mark.skipif(shutil.which("tmux") is None, reason="tmux is absent on this test host; computer image installs it")
def test_tmux_session_survives_terminal_reconnect():
    PtySession = _pty_module().PtySession
    first = PtySession(7)
    first.start()
    first.close_client()
    assert subprocess.run(["tmux", "has-session", "-t", "box-7"], check=False).returncode == 0
    second = PtySession(7)
    second.start()
    second.close_client()
    subprocess.run(["tmux", "kill-session", "-t", "box-7"], check=False)


def test_websocket_binary_and_fragmented_text_framing():
    import asyncio
    import struct

    module = _pty_module()

    def masked_frame(opcode, data, final=True):
        mask = b"test"
        head = bytes([(128 if final else 0) | opcode, 128 | len(data)])
        return head + mask + bytes(value ^ mask[i % 4] for i, value in enumerate(data))

    class Writer:
        def write(self, data):
            pass
        async def drain(self):
            pass
        def close(self):
            pass

    async def run():
        reader = asyncio.StreamReader()
        reader.feed_data(masked_frame(2, b"binary ", False) + masked_frame(0, b"data") +
                         masked_frame(1, b'{"type":"resize",', False) + masked_frame(0, b'"cols":80,"rows":24}'))
        transport = module.WebSocketTransport(reader, Writer())
        assert await transport.receive() == b"binary data"
        assert await transport.receive() == '{"type":"resize","cols":80,"rows":24}'

    asyncio.run(run())

