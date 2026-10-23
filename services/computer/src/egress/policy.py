from __future__ import annotations

import ipaddress
import json
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path

MAX_ENTRIES = 500
DEFAULTS = ("example.com", "*.github.com", "*.githubusercontent.com", "*.npmjs.org", "*.pypi.org")


@dataclass(frozen=True)
class NetworkPolicy:
    mode: str = "team_only"
    entries: tuple[str, ...] = ()
    locked: bool = False
    version: int = 0

    def __init__(self, mode="team_only", entries=(), locked=False, version=0, fail_closed=False):
        if mode not in {"allow_all", "defaults_with_team", "team_only"}:
            raise ValueError("invalid network policy mode")
        if isinstance(entries, (str, bytes)) or not isinstance(entries, (list, tuple)):
            raise ValueError("network policy entries must be a list")
        values = tuple(str(item).strip().lower().rstrip(".") for item in entries)
        if len(values) > MAX_ENTRIES or any(not x or len(x) > 253 or any(ord(c) < 32 for c in x) for x in values):
            raise ValueError("invalid network policy entries")
        for entry in values:
            host, port = _split_port(entry)
            if port is not None and not 1 <= port <= 65535:
                raise ValueError("invalid network policy port")
            host = host[2:] if host.startswith("*.") else host
            if "/" in host:
                ipaddress.ip_network(host, strict=False)
            else:
                try:
                    ipaddress.ip_address(host)
                except ValueError:
                    if not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?", host) or ".." in host:
                        raise ValueError("invalid network policy host")
        object.__setattr__(self, "mode", mode)
        object.__setattr__(self, "entries", tuple(dict.fromkeys(values)))
        object.__setattr__(self, "locked", bool(locked))
        object.__setattr__(self, "version", int(version))
        object.__setattr__(self, "fail_closed", bool(fail_closed))

    def with_group_entries(self, entries):
        return self if self.locked else NetworkPolicy(self.mode, (*self.entries, *entries), False, self.version)

    def allows(self, host: str, port: int) -> bool:
        if self.mode == "allow_all":
            return True
        candidates = (self.entries + (DEFAULTS if self.mode == "defaults_with_team" else ()))
        host = host.strip("[]").lower().rstrip(".")
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            address = None
        for entry in candidates:
            item, match_port = _split_port(entry)
            if match_port is not None and match_port != port:
                continue
            if item.startswith("*."):
                suffix = item[1:]
                if host.endswith(suffix) and len(host) > len(suffix):
                    return True
            elif "/" in item:
                try:
                    if address is not None and address in ipaddress.ip_network(item, strict=False):
                        return True
                except ValueError:
                    continue
            elif host == item:
                return True
        return False

    def block_reason(self, host):
        return "blocked by policy: add " + host[:253]


def _split_port(value):
    # IPv6 literals/CIDRs are bracketed when a port is included.
    if value.startswith("[") and "]" in value:
        end = value.index("]")
        host = value[1:end]
        suffix = value[end + 1:]
        return host, int(suffix[1:]) if suffix.startswith(":") and suffix[1:].isdigit() else None
    if value.count(":") == 1:
        host, raw = value.rsplit(":", 1)
        if raw.isdigit():
            n = int(raw)
            if not 1 <= n <= 65535:
                raise ValueError("invalid network policy port")
            return host, n
    return value, None


class PolicyFile:
    """Versioned, bounded JSON policy reader with a 60 second reload ceiling."""
    def __init__(self, path: str | os.PathLike, poll_seconds=5):
        self.path = Path(path)
        self.poll_seconds = min(max(float(poll_seconds), 0.25), 60)
        self._stat = None
        self._checked = 0.0
        self.policy = None

    def current(self):
        now = time.monotonic()
        if now - self._checked < self.poll_seconds:
            return self.policy
        self._checked = now
        try:
            stat = self.path.stat()
            marker = (stat.st_mtime_ns, stat.st_size)
            if marker != self._stat:
                if stat.st_size > 64_000:
                    raise ValueError("network policy file too large")
                raw = json.loads(self.path.read_text(encoding="utf-8"))
                if not isinstance(raw, dict) or (self.policy is not None and int(raw.get("version", 0)) < self.policy.version):
                    raise ValueError("stale network policy version")
                candidate = NetworkPolicy(raw.get("mode", "team_only"), raw.get("entries", []), raw.get("locked", False), raw.get("version", 0), raw.get("failClosed", False))
                self.policy = candidate
                self._stat = marker
        except FileNotFoundError:
            pass
        except (OSError, ValueError, json.JSONDecodeError):
            # Keep the last known-good policy. No snapshot means callers fail closed.
            pass
        return self.policy
