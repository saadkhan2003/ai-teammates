"""RAM-only private browser profile helpers."""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Callable

try:
    from .box_contract import TAILNET_CHROME_CDP
except ImportError:  # computer service runs this as a top-level module
    from box_contract import TAILNET_CHROME_CDP


def _unescape_mount_path(value: str) -> str:
    return value.replace("\\040", " ").replace("\\011", "\t").replace("\\134", "\\")


def is_tmpfs_mount(path: str | Path, mountinfo: str | None = None) -> bool:
    target = os.path.realpath(path)
    if mountinfo is None:
        mountinfo = Path("/proc/self/mountinfo").read_text(encoding="utf-8", errors="replace")
    for line in mountinfo.splitlines():
        fields = line.split()
        if "-" not in fields:
            continue
        separator = fields.index("-")
        if separator + 1 >= len(fields) or len(fields) < 6:
            continue
        mountpoint = os.path.realpath(_unescape_mount_path(fields[4]))
        if mountpoint == target and fields[separator + 1] == "tmpfs":
            return True
    return False


def private_host_matches(host: str, suffixes) -> bool:
    normalized = host.rstrip(".").lower()
    for value in suffixes:
        suffix = str(value).strip().lower().lstrip("*.").rstrip(".")
        if suffix and (normalized == suffix or normalized.endswith("." + suffix)):
            return True
    return False


def private_browser_url_allowed(url: str, suffixes) -> bool:
    from urllib.parse import urlsplit
    if not isinstance(url, str) or len(url) > 4096:
        return False
    try:
        parsed = urlsplit(url)
        return parsed.scheme in {"http", "https"} and bool(parsed.hostname) and parsed.username is None and parsed.password is None and private_host_matches(parsed.hostname, suffixes)
    except ValueError:
        return False


class PrivateBrowserUnavailable(PermissionError):
    """Private browser is unavailable for a cloned/untrusted session (launcher exit 75)."""
    exit_code = 75


def load_host_suffixes(path: str | Path) -> tuple[str, ...]:
    try:
        lines = Path(path).read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return ()
    if len(lines) > 500 or sum(map(len, lines)) > 32_768:
        raise ValueError("private host list exceeds its size limit")
    suffixes = []
    for line in lines:
        value = line.strip().lower().lstrip("*.").rstrip(".")
        if not value or value.startswith("#"):
            continue
        if len(value) > 253 or "/" in value or ":" in value or " " in value or ".." in value or not all(label and len(label) <= 63 and label[0] != "-" and label[-1] != "-" and all(c.isascii() and (c.isalnum() or c == "-") for c in label) for label in value.split(".")):
            raise ValueError("invalid private host suffix")
        suffixes.append(value)
    return tuple(suffixes)


def replace_host_suffixes(hosts, path: str | Path = "/tmp/private-host-suffixes") -> None:
    values = list(hosts)
    if len(values) > 500:
        raise ValueError("private host list exceeds its size limit")
    normalized = []
    for entry in values:
        if not isinstance(entry, str) or len(entry) > 255:
            raise ValueError("invalid private host suffix")
        suffix = entry.strip().lower()
        if suffix.startswith("*."):
            suffix = suffix[2:]
        if suffix.endswith("."):
            suffix = suffix[:-1]
        if not suffix:
            raise ValueError("invalid private host suffix")
        # Reuse the strict file parser's validation before replacing the live file.
        labels = suffix.split(".")
        if len(suffix) > 253 or ".." in suffix or not all(label and len(label) <= 63 and label[0] != "-" and label[-1] != "-" and all(c.isascii() and (c.isalnum() or c == "-") for c in label) for label in labels):
            raise ValueError("invalid private host suffix")
        normalized.append(suffix)
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".private-hosts-", dir=target.parent, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write("".join(host + "\n" for host in sorted(set(normalized))))
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


async def block_normal_browser_private_hosts(page, path: str | Path | None = None) -> None:
    """Attach request interception to normal browser pages; the private profile opts out."""
    suffixes = load_host_suffixes(path or os.environ.get("PRIVATE_HOST_SUFFIXES_FILE", "/tmp/private-host-suffixes"))

    async def route_request(route):
        from urllib.parse import urlsplit
        host = urlsplit(route.request.url).hostname or ""
        if private_host_matches(host, suffixes):
            await route.abort("blockedbyclient")
        else:
            await route.continue_()

    await page.route("**/*", route_request)


class PrivateBrowser:
    def __init__(self, profile: str | Path = "/home/box/private", *, trusted_session: bool | None = None,
                 mountinfo: str | None = None, launcher: Callable | None = None):
        self.profile = Path(profile)
        self.trusted_session = trusted_session if trusted_session is not None else os.environ.get("BOX_UNTRUSTED_TURN_CLONE") != "1"
        self.mountinfo = mountinfo
        self.launcher = launcher or subprocess.Popen
        self.custom_launcher = launcher is not None
        self.process = None

    def _require_private_mount(self) -> None:
        if not self.trusted_session:
            raise PrivateBrowserUnavailable("private browser unavailable for untrusted session")
        if self.profile.is_symlink():
            raise RuntimeError("private browser profile path must not be a symlink")
        if not is_tmpfs_mount(self.profile, self.mountinfo):
            raise RuntimeError("private browser profile must be a tmpfs mount")

    def start(self, executable: str = "chromium"):
        self._require_private_mount()
        if self.process is not None and self.process.poll() is None:
            return self.process
        self.profile.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.profile, 0o700)
        args = [executable, f"--user-data-dir={self.profile}", f"--remote-debugging-port={TAILNET_CHROME_CDP}", "--remote-debugging-address=127.0.0.1", "--no-first-run"]
        if not self.custom_launcher and os.geteuid() == 0:
            import pwd
            account = pwd.getpwnam("desk")
            os.chown(self.profile, account.pw_uid, account.pw_gid)
            args = ["runuser", "-u", "desk", "--", *args]
        self.process = self.launcher(args, close_fds=True)
        return self.process

    def stop(self) -> None:
        if self.process is not None:
            if self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=5)
            self.process = None

    def wipe(self) -> None:
        self._require_private_mount()
        self.stop()
        if self.profile.exists():
            for child in self.profile.iterdir():
                if child.is_dir() and not child.is_symlink():
                    shutil.rmtree(child)
                else:
                    child.unlink()
