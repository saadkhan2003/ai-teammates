"""Strip hidden-instruction markers and strict data before anything reaches the model."""
from __future__ import annotations

import json
import re
import shlex

MARKER = "CANARY-INJECT"
_LINE_SKIP = (
    "ignore previous instructions",
    "ignore your previous instructions",
    "disregard the user",
)
_SECRET = [
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"sk-or-[A-Za-z0-9_\-]{10,}"),
    re.compile(r"sk-[A-Za-z0-9_\-]{10,}"),
    re.compile(r"ghp_[A-Za-z0-9]{10,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{10,}"),
    re.compile(r"glpat-[A-Za-z0-9_\-]{10,}"),
    re.compile(r"xox[baprs]-[A-Za-z0-9\-]{10,}"),
    re.compile(r"\b\d{5}-\d{7}-\d\b"),
    re.compile(r"(?i)\bpassport\b[:\s#]*[A-Z0-9]{6,12}\b"),
]
_CARD = re.compile(r"\b(?:\d[ -]?){12,18}\d\b")
_UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def _inside_uuid(text: str, start: int, end: int) -> bool:
    left = start
    while left > 0 and (text[left - 1] == "-" or text[left - 1] in "0123456789abcdefABCDEF"):
        left -= 1
    right = end
    while right < len(text) and (text[right] == "-" or text[right] in "0123456789abcdefABCDEF"):
        right += 1
    return right - left == 36 and _UUID.match(text[left:right]) is not None


def _redact_card(match: re.Match) -> str:
    if _inside_uuid(match.string, match.start(), match.end()):
        return match.group(0)
    digits = re.sub(r"\D", "", match.group(0))
    return "[REDACTED]" if _luhn(digits) else match.group(0)


def _luhn(digits: str) -> bool:
    if not digits.isdigit() or not 13 <= len(digits) <= 19:
        return False
    total = 0
    alt = False
    for char in reversed(digits):
        num = ord(char) - 48
        if alt:
            num *= 2
            if num > 9:
                num -= 9
        total += num
        alt = not alt
    return total % 10 == 0


def strip_text(text: str) -> str:
    if not text:
        return text or ""
    kept = []
    for line in text.replace("\r\n", "\n").split("\n"):
        lowered = line.lower()
        if MARKER.lower() in lowered:
            continue
        if any(phrase in lowered for phrase in _LINE_SKIP):
            continue
        kept.append(line)
    cleaned = "\n".join(kept).replace(MARKER, "")
    for pattern in _SECRET:
        cleaned = pattern.sub("[REDACTED]", cleaned)
    cleaned = _CARD.sub(_redact_card, cleaned)
    return cleaned


HALT_STATUSES = {"waiting_approval", "needs_human", "control_lost", "waiting_human"}
LOGIN_STATUSES = {"filled", "expired", "cancelled", "denied"}


def should_halt(status) -> bool:
    """A login form and an approval both stop the worker. The model does not see a result yet."""
    return status in HALT_STATUSES


def stamp_actor(payload: dict, worker_id: str) -> dict:
    """Attach a bounded, non-secret actor id to computer-action API requests."""
    if not isinstance(payload, dict) or not isinstance(worker_id, str) or not worker_id or len(worker_id) > 120:
        raise ValueError("invalid action actor")
    stamped = dict(payload)
    stamped["actor_id"] = "agent:" + worker_id
    return stamped


def login_result(body: dict) -> dict:
    output = body.get("output") if isinstance(body.get("output"), dict) else {}
    login_status = str(output.get("status") or body.get("status") or "denied")
    if login_status not in LOGIN_STATUSES:
        login_status = "denied"
    return {"status": login_status}


_FETCH = re.compile(r"(?i)(\bcurl\b|\bwget\b|\bhttpie\b|\blynx\b|https?://|\burllib\b|\brequests\.(get|post|head)\b)")


def fetches_web(command: str) -> bool:
    return bool(_FETCH.search(command or ""))


def wrap_untrusted(text: str, source: str) -> str:
    body = text or ""
    if body.startswith("[untrusted "):
        return body
    return f"[untrusted {source} content]\n{body}\n[/untrusted]"


def present_tool(name: str, args: dict | None, result):
    """Browser text and shell output that fetched a page are untrusted data."""
    if not isinstance(result, dict):
        return result
    if name in {"watch_video", "ask_video"}:
        def mark_video(value):
            if isinstance(value, list):
                return [mark_video(item) for item in value]
            if isinstance(value, dict):
                return {key: wrap_untrusted(item, "video") if key in {"summary", "text", "content", "transcript", "answer"} and isinstance(item, str)
                        else mark_video(item) for key, item in value.items()}
            return value
        return dict(mark_video(result), untrusted=True)
    if name in {"browser_open", "browser_extract", "browser_click", "browser_screenshot"} and "text" in result:
        marked = dict(result)
        marked["text"] = wrap_untrusted(str(result.get("text") or ""), "web")
        marked["untrusted"] = True
        return marked
    if name == "thread_status" and result.get("lastMessage"):
        marked = dict(result)
        marked["lastMessage"] = wrap_untrusted(str(result.get("lastMessage")), "peer bot")
        marked["untrusted"] = True
        return marked
    if name == "list_bots" and isinstance(result.get("bots"), list):
        marked = dict(result)
        marked["bots"] = [dict(b, bio=wrap_untrusted(str(b.get("bio") or ""), "peer bot")) if isinstance(b, dict) and b.get("bio") else b for b in result["bots"]]
        marked["untrusted"] = True
        return marked
    command = ""
    if isinstance(args, dict):
        command = str(args.get("command") or "")
    if name in {"shell", "setup_env"} and fetches_web(command):
        marked = dict(result)
        output = marked.get("output")
        target = output if isinstance(output, dict) else marked
        updated = dict(target)
        for key in ("stdout", "stderr"):
            if key in updated and updated[key] is not None:
                updated[key] = wrap_untrusted(str(updated[key]), "shell")
        updated["untrusted"] = True
        if isinstance(output, dict):
            marked["output"] = updated
            marked["untrusted"] = True
            return marked
        return updated
    return result


def invalid_reason(result) -> str | None:
    if not isinstance(result, dict):
        return None
    if result.get("status") == "invalid":
        return str(result.get("reason") or "invalid tool call")
    output = result.get("output")
    if isinstance(output, dict) and output.get("status") == "invalid":
        return str(output.get("reason") or "invalid tool call")
    return None


def scrub(value):
    if isinstance(value, str):
        parsed = None
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return strip_text(value)
        return json.dumps(scrub(parsed))
    if isinstance(value, dict):
        return {key: scrub(item) for key, item in value.items() if key not in {"password", "otp", "value"}}
    if isinstance(value, list):
        return [scrub(item) for item in value]
    return value


RISKY_PREEXEC_TOOLS = {
    "shell", "setup_env", "write_file", "edit_file", "delete_file", "external_post", "send_message", "sign",
    "browser_click", "computer_click", "computer_type", "computer_key", "computer_use", "launch_app", "open_app",
    "automation_write", "delegate", "message_bot", "create_routine", "update_routine",
}


def normalize_argv(argv) -> list[str]:
    """Validate and canonicalize argv for exact command-shape approval matching."""
    if not isinstance(argv, (list, tuple)) or not 1 <= len(argv) <= 128:
        raise ValueError("invalid argv")
    normalized = []
    total = 0
    for item in argv:
        if not isinstance(item, str) or len(item) > 4096 or "\x00" in item:
            raise ValueError("invalid argv")
        value = item.strip()
        if not value:
            raise ValueError("invalid argv")
        total += len(value)
        normalized.append(value)
    if total > 16384:
        raise ValueError("argv too large")
    return normalized


def preexec_decision(tool: str, args: dict, request, *, endpoint: str = "/internal/tools/preexec") -> str:
    """Ask the authenticated API before a risky action. Any bad response fails closed."""
    if tool not in RISKY_PREEXEC_TOOLS:
        return "allow"
    if not isinstance(args, dict) or len(json.dumps(args, default=str)) > 32768:
        return "deny"
    if tool == "shell":
        command = args.get("command")
        if not isinstance(command, str) or len(command) > 16384:
            return "deny"
        try:
            args = dict(args, argv=normalize_argv(["/bin/sh", "-lc", command]))
        except ValueError:
            return "deny"
    try:
        response = request(endpoint, json={"tool": tool, "args": args}, timeout=5)
        if getattr(response, "status_code", 500) != 200:
            return "deny"
        result = response.json()
        if not isinstance(result, dict) or result.get("decision") not in {"allow", "ask", "deny"}:
            return "deny"
        return result["decision"]
    except Exception:
        return "deny"
