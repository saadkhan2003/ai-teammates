"""Per-bot workspace. One computer is shared. Each bot gets its own directory and uid."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
from pathlib import Path

try:
    from egress import firewall
except ImportError:  # shipped to the API and run as `python3 -c`, so the package is not on sys.path
    sys.path.insert(0, "/opt/desk/src")
    from egress import firewall

_HEX = set("0123456789abcdef")


def safe_id(bot_id: str) -> str:
    text = (bot_id or "").strip().replace("-", "").lower()
    if len(text) != 32 or any(char not in _HEX for char in text):
        raise ValueError("bad bot id")
    return text


def workspace_base() -> Path:
    return Path(os.environ.get("WORKSPACE_ROOT", "/data/workspace"))


def root_for(bot_id: str) -> Path:
    return workspace_base() / "bots" / safe_id(bot_id)


def bot_root() -> Path:
    raw = os.environ.get("BOT_ROOT", "")
    if not raw:
        raise RuntimeError("workspace_unavailable")
    return Path(raw).resolve()


def locate_under(root: Path, raw: str) -> Path:
    if "\x00" in (raw or ""):
        raise ValueError("invalid_path")
    text = (raw or "").strip() or "."
    if text == "/workspace" or text == "/workspace/":
        path = root
    elif text.startswith("/workspace/"):
        path = root / text[len("/workspace/") :]
    else:
        path = Path(text)
        if not path.is_absolute():
            path = root / path
    path = path.resolve()
    if path != root and root not in path.parents:
        raise PermissionError("path_escapes_workspace")
    return path


def locate(raw: str) -> Path:
    return locate_under(bot_root(), raw)


def publish_under(root: Path, path: Path) -> str:
    resolved = path.resolve()
    if resolved == root:
        return "/workspace"
    return "/workspace/" + resolved.relative_to(root).as_posix()


def publish(path: Path) -> str:
    return publish_under(bot_root(), path)


def home_for(bot_id: str) -> Path:
    return Path(os.environ.get("HOME_ROOT", "/data/home")) / safe_id(bot_id)


def rewrite_command(command: str, root: Path) -> str:
    # One replacement. The bot root itself contains "/workspace", and str.replace does not rescan.
    return (command or "").replace("/workspace", str(root))


def _state_file() -> Path:
    base = Path(os.environ.get("STATE_ROOT", "/data/state"))
    base.mkdir(parents=True, exist_ok=True)
    if os.geteuid() == 0:
        os.chmod(base, 0o700)
    return base / "bot-uids.json"


class WorkspaceDeleted(PermissionError):
    """The bot was deleted. Its folder must never be recreated or written again."""


def _tombstone(safe: str) -> Path:
    return Path(os.environ.get("STATE_ROOT", "/data/state")) / "deleted-bots" / safe


def is_deleted(bot_id: str) -> bool:
    try:
        safe = safe_id(bot_id)
    except ValueError:
        return False  # not a bot id; prepare() rejects it on its own
    return _tombstone(safe).exists()


def _assign_uid(bot_id: str) -> int:
    import fcntl

    path = _state_file()
    with path.open("a+", encoding="utf-8") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        handle.seek(0)
        raw = handle.read()
        try:
            mapping = json.loads(raw) if raw.strip() else {}
        except json.JSONDecodeError:
            mapping = {}
        if not isinstance(mapping, dict):
            mapping = {}
        current = mapping.get(bot_id)
        if isinstance(current, int) and current > 0:
            return current
        used = {int(value) for value in mapping.values() if isinstance(value, int)}
        # Each bot also owns a loopback dev-server port range derived from its uid
        # (egress/firewall.py), so two bots on one computer must not share a slot.
        used_slots = {firewall.dev_slot(value) for value in used}
        digest = int(hashlib.sha256(bot_id.encode()).hexdigest()[:6], 16)
        uid = 30000 + (digest % 20000)
        for _ in range(30000):
            if uid not in used and (firewall.dev_slot(uid) not in used_slots or len(used_slots) >= firewall.DEV_SLOTS):
                break
            uid += 1
            if uid > 59999:
                uid = 30000
        mapping[bot_id] = uid
        handle.seek(0)
        handle.truncate()
        handle.write(json.dumps(mapping))
        if os.geteuid() == 0:
            os.chmod(path, 0o600)
        return uid


def _own(path: Path, uid: int) -> None:
    if os.geteuid() != 0:
        return
    os.chown(path, uid, uid)
    for child in path.rglob("*"):
        os.chown(child, uid, uid)


def _account(uid: int, home: Path) -> None:
    if os.geteuid() != 0:
        return
    import pwd

    try:
        if pwd.getpwuid(uid).pw_uid == uid:
            return
    except KeyError:
        pass
    name = f"b{uid}"
    subprocess.run(["groupadd", "--gid", str(uid), name], check=False, capture_output=True)
    subprocess.run(
        ["useradd", "--uid", str(uid), "--gid", str(uid), "--home-dir", str(home), "--no-create-home", "--shell", "/bin/bash", name],
        check=False,
        capture_output=True,
    )


_FIREWALL_LOCK = threading.Lock()
_FIREWALL_APPLIED: frozenset[int] = frozenset()


def _all_bot_uids() -> frozenset[int]:
    try:
        raw = json.loads(_state_file().read_text(encoding="utf-8") or "{}")
    except (OSError, json.JSONDecodeError):
        return frozenset()
    return frozenset(int(v) for v in raw.values() if isinstance(v, int) and v > 0) if isinstance(raw, dict) else frozenset()


def enforce_firewall(force: bool = False) -> None:
    """Apply the per-bot nftables rules for every bot uid on this computer.

    COMPUTER_BOT_NFT: required (default; raise when the rules cannot be applied),
    auto (apply when root with nft, else warn), off (tests/dev only).
    """
    global _FIREWALL_APPLIED
    mode = os.environ.get("COMPUTER_BOT_NFT", "auto").strip().lower()
    if mode == "off" or os.geteuid() != 0:
        return
    uids = _all_bot_uids()
    with _FIREWALL_LOCK:
        if uids == _FIREWALL_APPLIED and not force:
            return
        try:
            firewall.apply(sorted(uids))
        except (RuntimeError, OSError) as exc:
            if mode == "required":
                raise RuntimeError("workspace_unavailable bot_firewall_not_applied") from exc
            print(f"bot firewall not applied: {exc}", file=sys.stderr)
            return
        _FIREWALL_APPLIED = frozenset(uids)


def dev_env(uid: int) -> dict[str, str]:
    low, high = firewall.dev_port_range(uid)
    return {"BOT_DEV_PORT_MIN": str(low), "BOT_DEV_PORT_MAX": str(high)}


def ensure(bot_id: str) -> int:
    safe = safe_id(bot_id)
    if _tombstone(safe).exists():
        raise WorkspaceDeleted("workspace_deleted")
    root = workspace_base() / "bots" / safe
    root.mkdir(parents=True, exist_ok=True)
    home = home_for(safe)
    home.mkdir(parents=True, exist_ok=True)
    uid = _assign_uid(safe)
    if os.geteuid() == 0:
        os.chmod(root.parent, 0o711)
        os.chown(root, uid, uid)
        os.chmod(root, 0o700)
        os.chown(home, uid, uid)
        os.chmod(home, 0o700)
        _account(uid, home)
        enforce_firewall()
        sample = root / "sample-repo"
        fixture = Path("/opt/fixtures/sample-repo")
        if fixture.is_dir() and not (sample / "calc.py").is_file():
            shutil.copytree(fixture, sample, dirs_exist_ok=True)
            _own(sample, uid)
    else:
        os.chmod(root, 0o700)
        os.chmod(home, 0o700)
    return uid


def prepare(bot_id: str) -> tuple[int, Path, Path]:
    uid = ensure(bot_id)
    return uid, root_for(bot_id), home_for(bot_id)


def desktop_scratch_id(bot_id: str) -> str:
    """A folder no bot owns, for a shared desktop whose bot was deleted."""
    return hashlib.sha256(("desktop-scratch:" + safe_id(bot_id)).encode()).hexdigest()[:32]


def desktop_identity(bot_id: str) -> tuple[int, Path, Path]:
    """uid, root and home for the processes of a desktop (window manager, panels,
    Chrome, native input). The shared per-owner desktop keeps running after its
    bot is deleted, so it then runs in a scratch folder of its own and never
    writes into the deleted bot's folder."""
    if is_deleted(bot_id):
        return prepare(desktop_scratch_id(bot_id))
    return prepare(bot_id)


def profile_root() -> Path:
    return Path(os.environ.get("PROFILE_ROOT", "/data/profiles"))


def profile_dir(bot_id: str) -> Path:
    """The Chrome profile of a desktop. It follows desktop_identity: a desktop
    whose bot was deleted gets a fresh scratch profile, never the deleted bot's
    cookies, logins or history."""
    safe = safe_id(bot_id)
    return profile_root() / (desktop_scratch_id(safe) if is_deleted(safe) else safe)


def _svc_ctl(*args: str) -> None:
    binary = os.environ.get("S6_SVC", "/command/s6-svc")
    if Path(binary).exists():
        subprocess.run([binary, *args], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30, check=False)


def _retire_browser_profile(safe: str, root: Path, home: Path) -> None:
    """Remove a deleted bot's Chrome profile. A shared desktop's Chrome that is
    still running on it is stopped first and started again on the desktop's
    scratch profile and identity."""
    old = profile_root() / safe
    services = Path(os.environ.get("DESK_SERVICE_DIR", "/run/service"))
    moved: list[tuple[Path, str]] = []
    for run in sorted(services.glob("chrome-*/run")) if services.is_dir() else []:
        try:
            script = run.read_text()
        except OSError:
            continue
        if f"--user-data-dir={old} " in script:
            _svc_ctl("-wD", "-T", "15000", "-d", str(run.parent))
            moved.append((run, script))
    if old.exists() or old.is_symlink():
        shutil.rmtree(old, ignore_errors=True)
    if not moved:
        return
    scratch = desktop_scratch_id(safe)
    uid = ensure(scratch)
    fresh = profile_root() / scratch
    fresh.mkdir(parents=True, exist_ok=True)
    if os.geteuid() == 0:
        os.chown(fresh, uid, uid)
        os.chmod(fresh, 0o700)
    for run, script in moved:
        script = script.replace(f"--user-data-dir={old} ", f"--user-data-dir={fresh} ")
        script = script.replace(f"export HOME={home}\n", f"export HOME={home_for(scratch)}\n")
        script = script.replace(f"export BOT_ROOT={root}\n", f"export BOT_ROOT={root_for(scratch)}\n")
        script = script.replace(f"export BOT_ID={safe}\n", f"export BOT_ID={scratch}\n")
        script = re.sub(r"--reuid \d+ --regid \d+", f"--reuid {uid} --regid {uid}", script)
        run.write_text(script)
        run.chmod(0o755)
        _svc_ctl("-u", str(run.parent))


_PRIV = threading.Lock()


def call_as(uid: int, fn):
    """Run fn as uid and return to root. The computer API process is root."""
    if os.geteuid() != 0:
        return fn()
    with _PRIV:
        saved = os.getgroups()
        os.setgroups([])
        os.setegid(uid)
        os.seteuid(uid)
        try:
            return fn()
        finally:
            os.seteuid(0)
            os.setegid(0)
            os.setgroups(saved)


def wipe(bot_id: str) -> None:
    safe = safe_id(bot_id)
    # Tombstone first so nothing can recreate the folder while it is being removed.
    stone = _tombstone(safe)
    stone.parent.mkdir(parents=True, exist_ok=True)
    stone.touch()
    root = workspace_base() / "bots" / safe
    home = home_for(safe)
    if root.exists():
        shutil.rmtree(root)
    if home.exists():
        shutil.rmtree(home)
    for extra in (workspace_base() / "outputs" / safe, workspace_base() / "outputs" / bot_id):
        if extra.exists():
            shutil.rmtree(extra)
    _retire_browser_profile(safe, root, home)
    path = _state_file()
    if not path.exists():
        return
    import fcntl

    with path.open("a+", encoding="utf-8") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        handle.seek(0)
        raw = handle.read()
        try:
            mapping = json.loads(raw) if raw.strip() else {}
        except json.JSONDecodeError:
            mapping = {}
        if isinstance(mapping, dict) and safe in mapping:
            # Keep the uid reserved: processes still running as the deleted bot
            # must never gain access to a new bot that reused its uid.
            mapping["retired:" + safe] = mapping.pop(safe, None)
            handle.seek(0)
            handle.truncate()
            handle.write(json.dumps(mapping))


def read_file(raw: str) -> None:
    path = locate(raw)
    if not path.is_file():
        print("not_found")
        raise SystemExit(2)
    print(path.read_text(errors="replace")[:100000])


def stat_file(raw: str) -> None:
    path = locate(raw)
    if path.is_dir():
        print("directory")
        raise SystemExit(3)
    if path.exists():
        print("present")
        return
    print("absent")
    raise SystemExit(2)


def write_file(raw: str, content: str) -> None:
    path = locate(raw)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


def write_b64(raw: str, payload: str) -> None:
    path = locate(raw)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(base64.b64decode(payload))


def append_b64(raw: str, payload: str) -> None:
    path = locate(raw)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("ab") as handle:
        handle.write(base64.b64decode(payload))


def read_b64(raw: str) -> None:
    path = locate(raw)
    if not path.is_file():
        raise SystemExit(2)
    sys.stdout.write(base64.b64encode(path.read_bytes()).decode())


def edit_file(raw: str, search: str, replace: str) -> None:
    path = locate(raw)
    if not path.is_file():
        print("not_found")
        raise SystemExit(2)
    text = path.read_text()
    if search not in text:
        print("search text not found")
        raise SystemExit(3)
    path.write_text(text.replace(search, replace, 1))


def delete_file(raw: str) -> None:
    path = locate(raw)
    if path.is_dir():
        print("directory")
        raise SystemExit(3)
    path.unlink(missing_ok=True)


def list_dir(raw: str) -> None:
    path = locate(raw)
    if not path.is_dir():
        print("[]")
        return
    rows = []
    for child in sorted(path.iterdir(), key=lambda item: item.name)[:200]:
        rows.append({"name": child.name, "path": publish(child), "directory": child.is_dir()})
    print(json.dumps(rows))


def read_artifact(raw: str) -> None:
    path = locate(raw)
    if not path.is_file():
        raise SystemExit(2)
    sys.stdout.write(base64.b64encode(path.read_bytes()).decode())
