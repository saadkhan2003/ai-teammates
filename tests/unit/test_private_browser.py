from __future__ import annotations

import asyncio
import pytest

from services.computer.src.box_contract import TAILNET_CHROME_CDP
from services.computer.src.private_browser import (
    PrivateBrowser, PrivateBrowserUnavailable, block_normal_browser_private_hosts,
    is_tmpfs_mount, private_host_matches, private_browser_url_allowed,
)


def test_private_host_suffix_blocks_parent_and_subdomains_only():
    assert private_host_matches("git.internal.example", ["internal.example"])
    assert private_host_matches("internal.example", ["internal.example"])
    assert not private_host_matches("evilinternal.example", ["internal.example"])
    assert not private_host_matches("internal.example.evil.test", ["internal.example"])


def test_private_browser_accepts_only_explicit_private_host_suffixes():
    assert private_browser_url_allowed("https://git.internal.example/repo", ["internal.example"])
    assert not private_browser_url_allowed("https://public.example/", ["internal.example"])
    assert not private_browser_url_allowed("file:///etc/passwd", ["internal.example"])
    assert not private_browser_url_allowed("https://internal.example@evil.test/", ["internal.example"])


def test_mountinfo_check_requires_exact_tmpfs_mountpoint():
    info = "22 1 0:19 / /home/box/private rw,nosuid - tmpfs tmpfs rw,size=1m"
    assert is_tmpfs_mount("/home/box/private", info)
    assert not is_tmpfs_mount("/home/box/private/subdir", info)
    assert not is_tmpfs_mount("/home/box/private", info.replace("tmpfs tmpfs", "ext4 /dev/vda"))


def test_private_profile_refuses_untrusted_or_non_tmpfs_before_launch(tmp_path):
    launched = []
    private = PrivateBrowser(profile=tmp_path / "private", trusted_session=False,
                             mountinfo="", launcher=lambda *args: launched.append(args))
    with pytest.raises(PermissionError, match="untrusted"):
        private.start()
    with pytest.raises(PrivateBrowserUnavailable) as error:
        private.start()
    assert error.value.exit_code == 75
    assert launched == []

    private = PrivateBrowser(profile=tmp_path / "private", trusted_session=True,
                             mountinfo="", launcher=lambda *args: launched.append(args))
    with pytest.raises(RuntimeError, match="tmpfs"):
        private.start()
    assert launched == []


def test_start_uses_contract_cdp_port_and_ram_profile(tmp_path):
    profile = tmp_path / "private"
    mountinfo = f"22 1 0:19 / {profile} rw,nosuid - tmpfs tmpfs rw,size=1m"
    calls = []

    class Process:
        def poll(self):
            return None

    private = PrivateBrowser(profile=profile, trusted_session=True, mountinfo=mountinfo,
                             launcher=lambda args, **kwargs: (calls.append((args, kwargs)) or Process()))
    private.start("chromium-test")
    assert calls[0][0][0] == "chromium-test"
    assert f"--remote-debugging-port={TAILNET_CHROME_CDP}" in calls[0][0]
    assert calls[0][1]["close_fds"] is True
    assert profile.stat().st_mode & 0o777 == 0o700


def test_normal_browser_intercepts_private_host_suffixes(tmp_path):
    host_file = tmp_path / "host-suffixes"
    host_file.write_text("# private range\ncorp.example\n", encoding="utf-8")

    class FakePage:
        async def route(self, pattern, handler):
            self.pattern, self.handler = pattern, handler

    class Request:
        def __init__(self, url):
            self.url = url

    class FakeRoute:
        def __init__(self, url):
            self.request = Request(url)
            self.action = None

        async def abort(self, reason):
            self.action = ("abort", reason)

        async def continue_(self):
            self.action = ("continue", None)

    async def run():
        page = FakePage()
        await block_normal_browser_private_hosts(page, host_file)
        blocked = FakeRoute("https://git.corp.example/repo")
        public = FakeRoute("https://example.org/")
        await page.handler(blocked)
        await page.handler(public)
        return page, blocked, public

    page, blocked, public = asyncio.run(run())
    assert page.pattern == "**/*"
    assert blocked.action == ("abort", "blockedbyclient")
    assert public.action == ("continue", None)


def test_wipe_removes_profile_contents(tmp_path):
    profile = tmp_path / "private"
    profile.mkdir()
    (profile / "Cookies").write_text("test-cookie")
    mountinfo = f"22 1 0:19 / {profile} rw,nosuid - tmpfs tmpfs rw,size=1m"
    private = PrivateBrowser(profile=profile, trusted_session=True, mountinfo=mountinfo)
    private.wipe()
    assert profile.is_dir()
    assert list(profile.iterdir()) == []


def test_lifecycle_stop_terminates_process_without_wiping(tmp_path):
    profile = tmp_path / "private"
    profile.mkdir()
    mountinfo = f"22 1 0:19 / {profile} rw,nosuid - tmpfs tmpfs rw,size=1m"
    class Process:
        terminated = False
        def poll(self): return None
        def terminate(self): self.terminated = True
        def wait(self, timeout): return 0
    process = Process()
    private = PrivateBrowser(profile=profile, trusted_session=True, mountinfo=mountinfo,
                             launcher=lambda *args, **kwargs: process)
    private.start()
    (profile / "Cookies").write_text("cookie")
    private.stop()
    assert process.terminated
    assert (profile / "Cookies").exists()
    assert private.process is None


def test_host_suffix_update_is_validated_and_atomic(tmp_path):
    from services.computer.src.private_browser import replace_host_suffixes
    target = tmp_path / "host-suffixes"
    replace_host_suffixes(["Corp.Example", "*.internal.test"], target)
    assert target.read_text().splitlines() == ["corp.example", "internal.test"]
    with pytest.raises(ValueError):
        replace_host_suffixes(["invalid/path"], target)
    assert target.read_text().splitlines() == ["corp.example", "internal.test"]


def test_private_browser_refuses_untrusted_wipe(tmp_path):
    profile = tmp_path / "private"
    profile.mkdir()
    mountinfo = f"22 1 0:19 / {profile} rw,nosuid - tmpfs tmpfs rw,size=1m"
    private = PrivateBrowser(profile=profile, trusted_session=False, mountinfo=mountinfo)
    with pytest.raises(PermissionError):
        private.wipe()
