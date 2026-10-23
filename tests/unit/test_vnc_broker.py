from __future__ import annotations

import random

import pytest

from services.computer.src.vnc_broker import RfbClientFilter, RfbProtocolError


def frame(kind: int, body: bytes) -> bytes:
    return bytes([kind]) + body


def test_watch_drops_key_pointer_and_cut_text_across_random_chunks():
    safe = frame(0, b"\x00" * 19) + frame(2, b"\x00\x00\x00") + frame(3, b"\x00" * 9)
    key = frame(4, b"\x01\x00\x00\x41\x00\x00\x00")
    pointer = frame(5, b"\x01\x00\x02\x00\x03")
    cut = frame(6, b"\x00" * 3 + b"\x00\x00\x00\x03abc")
    stream = safe + key + pointer + cut + safe
    for seed in range(30):
        rng = random.Random(seed)
        chunks, offset = [], 0
        while offset < len(stream):
            size = rng.randint(1, 9)
            chunks.append(stream[offset:offset + size])
            offset += size
        parser = RfbClientFilter("watch")
        forwarded = b"".join(parser.feed(chunk) for chunk in chunks)
        assert forwarded == safe + safe


def test_control_forwards_input_and_parser_holds_incomplete_frame():
    message = frame(5, b"\x01\x00\x02\x00\x03")
    parser = RfbClientFilter("control")
    assert parser.feed(message[:3]) == b""
    assert parser.feed(message[3:]) == message


def test_watch_rejects_unknown_or_extension_type():
    with pytest.raises(RfbProtocolError):
        RfbClientFilter("watch").feed(b"\x7f")


def test_cut_text_length_is_bounded():
    with pytest.raises(RfbProtocolError):
        RfbClientFilter("watch", max_message=8).feed(b"\x06\x00\x00\x00\xff\xff\xff\xff")


def test_fake_rfb_upstream_records_only_safe_watch_messages():
    class FakeRfbUpstream:
        def __init__(self):
            self.received = bytearray()

        def receive(self, payload: bytes):
            self.received.extend(payload)

    upstream = FakeRfbUpstream()
    parser = RfbClientFilter("watch")
    safe = frame(3, b"\x00" * 9)
    injected = frame(4, b"\x01\x00\x00\x41\x00\x00\x00")
    injected += frame(5, b"\x01\x00\x02\x00\x03")
    injected += frame(6, b"\x00" * 3 + b"\x00\x00\x00\x03abc")
    wire = safe + injected + safe
    for start in range(0, len(wire), 2):
        upstream.receive(parser.feed(wire[start:start + 2]))
    assert bytes(upstream.received) == safe + safe
