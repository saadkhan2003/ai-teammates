"""Pure validation and command builders for native desktop tools."""
from __future__ import annotations

import re
import os

KEYS = {"Return", "Tab", "Escape", "BackSpace", "Delete", "space", "Home", "End", "Page_Up", "Page_Down", "Left", "Right", "Up", "Down", "ctrl", "alt", "shift", "super"}
_KEY_PART = re.compile(r"^[A-Za-z0-9_]+$")
_NAME = re.compile(r"[^A-Za-z0-9._-]+")


def scale_point(x: int | float, y: int | float, real_width: int | None = None, real_height: int | None = None) -> tuple[int, int]:
    if real_width is None or real_height is None:
        raw = os.environ.get("DISPLAY_GEOMETRY", "1920x1200").lower().replace("x", " ").split()
        try:
            real_width, real_height = int(raw[0]), int(raw[1])
        except (IndexError, ValueError):
            real_width, real_height = 1920, 1200
    if real_width <= 0 or real_height <= 0 or not (0 <= x < 1280 and 0 <= y < 800):
        raise ValueError("invalid model coordinates")
    return min(real_width - 1, round(x * real_width / 1280)), min(real_height - 1, round(y * real_height / 800))


def validate_keys(keys: object) -> list[str]:
    if not isinstance(keys, list) or not 1 <= len(keys) <= 8:
        raise ValueError("keys must contain 1 to 8 key names")
    for key in keys:
        if not isinstance(key, str) or not key or len(key) > 48:
            raise ValueError("invalid key name")
        parts = key.split("+")
        if len(parts) > 4 or not all(_KEY_PART.fullmatch(part) for part in parts):
            raise ValueError("invalid key name")
        if any(part not in KEYS and not (len(parts) > 1 and part.isalnum() and len(part) == 1) for part in parts):
            raise ValueError("key is not allowlisted")
        if len(parts) > 1 and parts[0] not in {"ctrl", "alt", "shift", "super"}:
            raise ValueError("key combination needs an allowlisted modifier")
    return keys


def safe_recording_name(value: object) -> str:
    name = _NAME.sub("-", str(value or "screen-recording")).strip(".-_")[:80]
    return name or "screen-recording"


def ffmpeg_argv(display: int, width: int, height: int, path: str, max_seconds: int, encoder: str = "libvpx-vp9") -> list[str]:
    if encoder not in {"libvpx-vp9", "libx264"}:
        raise ValueError("unsupported encoder")
    args = ["ffmpeg", "-y", "-f", "x11grab", "-framerate", "5", "-video_size", f"{width}x{height}", "-i", f":{display}.0", "-an", "-t", str(max_seconds)]
    if encoder == "libx264":
        args += ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"]
    else:
        args += ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8"]
    return args + [path]
