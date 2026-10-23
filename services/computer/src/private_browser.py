"""RAM-only private browser profile helpers."""
from __future__ import annotations

import os
import shutil
import subprocess
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
        if len(value) > 253 or "/" in value or ":" in value or " " in value or ".." in value:
            raise ValueError("invalid private host suffix")
        suffixes.append(value)
    return tuple(suffixes)


async def block_normal_browser_private_hosts(page, path: str | Path = "/var/lib/teammates/private/host-suffixes") -> None:
    """Attach request interception to normal browser pages; the private profile opts out."""
    suffixes = load_host_suffixes(path)

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
        self.process = self.launcher(args, close_fds=True)
        return self.process

    def wipe(self) -> None:
        self._require_private_mount()
        if self.process is not None and self.process.poll() is None:
            self.process.terminate()
            self.process.wait(timeout=5)
        self.process = None
        if self.profile.exists():
            for child in self.profile.iterdir():
                if child.is_dir() and not child.is_symlink():
                    shutil.rmtree(child)
                else:
                    child.unlink()
