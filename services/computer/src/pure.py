"""Pure helpers shared by the computer runtime. No Playwright import."""
from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import urlsplit

WORKSPACE = Path("/data/workspace")

ATTENTION_PHRASES = (
    "please complete the captcha",
    "verify you are human",
    "multi-factor authentication",
    "enter the one-time code",
    "mfa required",
)

SECRET_PATTERNS = [
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"sk-or-[A-Za-z0-9_\-]{10,}"),
    re.compile(r"sk-[A-Za-z0-9_\-]{10,}"),
    re.compile(r"ghp_[A-Za-z0-9]{10,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{10,}"),
    re.compile(r"glpat-[A-Za-z0-9_\-]{10,}"),
    re.compile(r"xox[baprs]-[A-Za-z0-9\-]{10,}"),
]


def redact(text: str, extras: list[str] | None = None) -> str:
    if not text:
        return text
    out = text
    for pattern in SECRET_PATTERNS:
        out = pattern.sub("[REDACTED]", out)
    for extra in extras or []:
        if extra and len(extra) >= 6 and extra in out:
            out = out.replace(extra, "[REDACTED]")
    return out


def attention_reason(text: str) -> str | None:
    lowered = (text or "").lower()
    for phrase in ATTENTION_PHRASES:
        if phrase in lowered:
            return "captcha_or_mfa"
    return None


def resolve_workspace(raw: str) -> Path:
    text = (raw or "").strip() or "."
    if text.startswith("/workspace"):
        rel = text[len("/workspace") :].lstrip("/")
        path = (WORKSPACE / rel).resolve()
    elif text.startswith("/"):
        path = Path(text).resolve()
    else:
        path = (WORKSPACE / text).resolve()
    root = WORKSPACE.resolve()
    if path != root and root not in path.parents:
        raise ValueError("path escapes workspace")
    return path


def looks_like_phish(host: str) -> bool:
    text = (host or "").lower().rstrip(".")
    return "xn--" in text or text.endswith(".evil.test") or ".evil." in text


def origin_of(url: str) -> str:
    if not url or url.startswith("about:"):
        return ""
    parts = urlsplit(url)
    if not parts.scheme or not parts.hostname:
        return ""
    port = parts.port
    host = parts.hostname
    default = (parts.scheme == "https" and port in (None, 443)) or (parts.scheme == "http" and port in (None, 80))
    if default or port is None:
        shown = f"{parts.scheme}://{host}"
        if port and not default:
            shown += f":{port}"
        return shown
    return f"{parts.scheme}://{host}:{port}"


def origins_equal(left: str, right: str) -> bool:
    return origin_of(left if "://" in left else "http://" + left) == origin_of(
        right if "://" in right else "http://" + right
    ) and origin_of(left if "://" in left else "") != ""


def scrub_tree(values: list[str], root: Path = WORKSPACE) -> int:
    changed = 0
    if not root.exists():
        return 0
    blobs = [v.encode() for v in values if v and len(v) >= 6]
    if not blobs:
        return 0
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        try:
            if path.stat().st_size > 2_000_000:
                continue
            data = path.read_bytes()
        except OSError:
            continue
        updated = data
        for blob in blobs:
            if blob in updated:
                updated = updated.replace(blob, b"[REDACTED]")
        if updated != data:
            path.write_bytes(updated)
            changed += 1
    return changed
