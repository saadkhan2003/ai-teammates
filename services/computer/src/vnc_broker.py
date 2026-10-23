"""Incremental RFB client-message filter for view-only websocket sessions."""
from __future__ import annotations

import struct


class RfbProtocolError(ValueError):
    """Malformed, oversized, or unsupported client RFB message."""


class RfbClientFilter:
    # RFB client-to-server messages: SetPixelFormat, SetEncodings,
    # FramebufferUpdateRequest, KeyEvent, PointerEvent, ClientCutText.
    _FIXED = {0: 20, 2: 4, 3: 10, 4: 8, 5: 6}
    _INPUT = {4, 5, 6}

    def __init__(self, role: str, max_message: int = 1 << 20):
        if role not in {"watch", "control"}:
            raise ValueError("role must be watch or control")
        if not 1 <= max_message <= 16 << 20:
            raise ValueError("invalid RFB message limit")
        self.role = role
        self.max_message = max_message
        self._pending = bytearray()

    def feed(self, data: bytes) -> bytes:
        if len(self._pending) + len(data) > self.max_message + 8:
            raise RfbProtocolError("incomplete RFB message exceeds limit")
        self._pending.extend(data)
        forwarded = bytearray()
        offset = 0
        while offset < len(self._pending):
            kind = self._pending[offset]
            if kind == 6:
                if len(self._pending) - offset < 8:
                    break
                length = 8 + struct.unpack_from(">I", self._pending, offset + 4)[0]
            elif kind == 2:
                if len(self._pending) - offset < 4:
                    break
                length = 4 + 4 * struct.unpack_from(">H", self._pending, offset + 2)[0]
            elif kind in self._FIXED:
                length = self._FIXED[kind]
            else:
                raise RfbProtocolError("unsupported RFB client message")
            if length > self.max_message:
                raise RfbProtocolError("RFB client message exceeds limit")
            if len(self._pending) - offset < length:
                break
            message = self._pending[offset:offset + length]
            if self.role != "watch" or kind not in self._INPUT:
                forwarded.extend(message)
            offset += length
        if offset:
            del self._pending[:offset]
        return bytes(forwarded)

    @property
    def has_partial_message(self) -> bool:
        return bool(self._pending)
