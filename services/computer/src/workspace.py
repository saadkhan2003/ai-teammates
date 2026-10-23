"""Per-bot workspace. One computer is shared. Each bot gets its own directory and uid."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import threading
from pathlib import Path

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
        digest = int(hashlib.sha256(bot_id.encode()).hexdigest()[:6], 16)
        uid = 30000 + (digest % 20000)
        while uid in used:
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


def ensure(bot_id: str) -> int:
    safe = safe_id(bot_id)
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
    root = workspace_base() / "bots" / safe
    home = home_for(safe)
    if root.exists():
        shutil.rmtree(root)
    if home.exists():
        shutil.rmtree(home)
    for extra in (workspace_base() / "outputs" / safe, workspace_base() / "outputs" / bot_id):
        if extra.exists():
            shutil.rmtree(extra)
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
            mapping.pop(safe, None)
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
