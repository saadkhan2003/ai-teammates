"""HMAC terminal tickets with short expiry and process-local single-use tracking."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import threading
import time


class TicketError(ValueError):
    """A deliberately generic authentication failure; callers must not log the token."""


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _unb64(value: str) -> bytes:
    if not value or len(value) > 8192 or any(c not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_=" for c in value):
        raise TicketError("invalid ticket")
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


class TicketStore:
    def __init__(self, secret: bytes):
        if len(secret) < 32:
            raise ValueError("terminal ticket secret must be at least 32 bytes")
        self._secret = bytes(secret)
        self._consumed: dict[str, int] = {}
        self._lock = threading.Lock()

    def issue(self, user: str, bot: str, window: int, role: str, *, computer: str = "computer", now: int | None = None, ttl: int = 60) -> str:
        if not 1 <= window <= 8 or role not in {"user", "watch", "control"}:
            raise ValueError("invalid ticket scope")
        if any(not isinstance(value, str) or not value or len(value) > 128 for value in (computer, user, bot)):
            raise ValueError("invalid ticket scope")
        if not 1 <= ttl <= 60:
            raise ValueError("ticket lifetime must be at most 60 seconds")
        claims = {
            "computer": computer,
            "user": user,
            "bot": bot,
            "window": window,
            "role": role,
            "exp": int(time.time() if now is None else now) + ttl,
            "nonce": _b64(secrets.token_bytes(32)),
        }
        payload = _b64(json.dumps(claims, separators=(",", ":"), sort_keys=True).encode())
        signature = _b64(hmac.new(self._secret, payload.encode("ascii"), hashlib.sha256).digest())
        return payload + "." + signature

    def verify(self, token: str, *, now: int | None = None) -> dict:
        try:
            if not isinstance(token, str) or len(token) > 8192:
                raise TicketError("invalid ticket")
            payload, signature = token.split(".", 1)
            expected = hmac.new(self._secret, payload.encode("ascii"), hashlib.sha256).digest()
            if not hmac.compare_digest(expected, _unb64(signature)):
                raise TicketError("invalid ticket")
            claims = json.loads(_unb64(payload))
            if not isinstance(claims, dict) or set(claims) != {"computer", "user", "bot", "window", "role", "exp", "nonce"}:
                raise TicketError("invalid ticket")
            if not isinstance(claims["exp"], int) or isinstance(claims["exp"], bool) or claims["exp"] <= int(time.time() if now is None else now):
                raise TicketError("invalid ticket")
            if not (isinstance(claims["window"], int) and not isinstance(claims["window"], bool) and 1 <= claims["window"] <= 8):
                raise TicketError("invalid ticket")
            if claims["role"] not in {"user", "watch", "control"}:
                raise TicketError("invalid ticket")
            if any(not isinstance(claims[field], str) or not claims[field] or len(claims[field]) > 128 for field in ("computer", "user", "bot")):
                raise TicketError("invalid ticket")
            if claims["exp"] > int(time.time() if now is None else now) + 60:
                raise TicketError("invalid ticket")
            if len(_unb64(claims["nonce"])) < 16:
                raise TicketError("invalid ticket")
            return claims
        except (ValueError, TypeError, KeyError, UnicodeError, json.JSONDecodeError) as exc:
            if isinstance(exc, TicketError):
                raise
            raise TicketError("invalid ticket") from None

    def consume(self, token: str, user: str, bot: str, window: int, role: str, *, computer: str = "computer", now: int | None = None) -> bool:
        claims = self.verify(token, now=now)
        checks = ((claims["computer"], computer), (claims["user"], user), (claims["bot"], bot), (str(claims["window"]), str(window)), (claims["role"], role))
        if any(not hmac.compare_digest(str(actual).encode(), str(expected).encode()) for actual, expected in checks):
            raise TicketError("invalid ticket")
        expiry = claims["exp"]
        digest = hashlib.sha256(token.encode("ascii")).hexdigest()
        timestamp = int(time.time() if now is None else now)
        with self._lock:
            self._consumed = {key: expires for key, expires in self._consumed.items() if expires > timestamp}
            if digest in self._consumed:
                raise TicketError("invalid ticket")
            self._consumed[digest] = expiry
        return True
