"""Per-bot Xvfb + xfwm4 + picom + Plank + on-demand x11vnc + Chrome supervision via s6-overlay."""
from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass, field
from pathlib import Path

import workspace

S6_SCAN = "/command/s6-svscanctl"
S6_SVC = "/command/s6-svc"
STATE_PATH = Path("/data/state/desktops.json")


@dataclass
class Desktop:
    bot_id: str
    display: int
    name: str = "Teammate"
    holder: str = "agent"
    epoch: int = 1
    chrome: bool = False
    hidden: bool = False


@dataclass
class TokenBook:
    entries: dict[str, str] = field(default_factory=dict)

    def replace_bot(self, bot_prefix: str, pairs: dict[str, str]) -> None:
        self.entries = {k: v for k, v in self.entries.items() if not k.startswith(bot_prefix)}
        self.entries.update(pairs)
        self.flush()

    def drop_prefix(self, prefix: str) -> None:
        self.entries = {k: v for k, v in self.entries.items() if not k.startswith(prefix)}
        self.flush()

    def flush(self) -> None:
        path = Path("/run/desk/vnc.tokens")
        tmp = path.with_suffix(".tokens.tmp")
        lines = [f"{token}: {target}\n" for token, target in self.entries.items()]
        tmp.write_text("".join(lines))
        os.chmod(tmp, 0o640)
        os.replace(tmp, path)


# One renderer, no GPU process, no background Chrome services, and a small disk cache.
# Launch /usr/lib/chromium/chromium directly. The Debian wrapper in /usr/bin/chromium
# turns GPU rasterization and extension loading back on.
# The API bridges RFB itself, so x11vnc stays down until a viewer connects.
CHROME_FLAGS = (
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-software-rasterizer",
    "--disable-gpu-compositing",
    "--in-process-gpu",
    "--use-gl=disabled",
    "--disable-extensions",
    "--disable-component-extensions-with-background-pages",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-domain-reliability",
    "--disable-client-side-phishing-detection",
    "--disable-breakpad",
    "--disable-crash-reporter",
    "--disable-hang-monitor",
    "--no-pings",
    "--metrics-recording-only",
    "--mute-audio",
    "--renderer-process-limit=1",
    "--num-raster-threads=1",
    "--disk-cache-size=33554432",
    "--media-cache-size=1",
    "--aggressive-cache-discard",
    "--disable-features=Translate,MediaRouter,BackForwardCache,InterestFeedContentSuggestions,OptimizationHints,AudioServiceOutOfProcess,IsolateOrigins,site-per-process,Crashpad,SpareRendererForSitePerProcess,CalculateNativeWinOcclusion",
    "--js-flags=--max-old-space-size=64",
)


def geometry() -> tuple[int, int]:
    raw = os.environ.get("DISPLAY_GEOMETRY", "1920x1200")
    parts = raw.lower().replace("x", " ").split()
    try:
        return int(parts[0]), int(parts[1])
    except (IndexError, ValueError):
        return 1920, 1200


def depth() -> int:
    raw = os.environ.get("DISPLAY_DEPTH", "24")
    try:
        value = int(raw)
    except ValueError:
        return 24
    return value if value in (8, 16, 24) else 24


def chrome_bin() -> str:
    # The /usr/bin/chromium wrapper sources /etc/chromium.d and prepends
    # --enable-gpu-rasterization plus --load-extension. Skip it.
    for candidate in ("/usr/lib/chromium/chromium", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"):
        if Path(candidate).exists():
            return candidate
    raise RuntimeError("chromium is not installed")


def cdp_port(display: int) -> int:
    override = os.environ.get("CDP_PORT", "").strip()
    return int(override) + display - 1 if override else 9222 + display


def view_port(display: int) -> int:
    override = os.environ.get("VNC_VIEW_PORT", "").strip()
    return int(override) + display - 1 if override else 5900 + display


def rw_port(display: int) -> int:
    override = os.environ.get("VNC_RW_PORT", "").strip()
    return int(override) + display - 1 if override else 6900 + display


async def _run(args: list[str]) -> None:
    proc = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
    await proc.wait()


def _write_service(name: str, script: str, down: bool = False) -> None:
    directory = Path("/run/service") / name
    directory.mkdir(parents=True, exist_ok=True)
    run = directory / "run"
    run.write_text(script)
    run.chmod(0o755)
    down_file = directory / "down"
    if down:
        down_file.write_text("")
    elif down_file.exists():
        down_file.unlink()


async def _rescan() -> None:
    await _run([S6_SCAN, "-a", "/run/service"])


async def _svc(*args: str) -> None:
    await _run([S6_SVC, *args])


async def _wait_x(display: int, timeout: float = 20) -> None:
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        proc = await asyncio.create_subprocess_exec(
            "xdpyinfo", "-display", f":{display}",
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
        )
        code = await proc.wait()
        if code == 0:
            return
        await asyncio.sleep(0.2)
    raise TimeoutError(f"X display :{display} did not come up")


async def _wait_port(port: int, timeout: float = 30) -> None:
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        try:
            reader, writer = await asyncio.wait_for(asyncio.open_connection("127.0.0.1", port), timeout=1)
            writer.close()
            await writer.wait_closed()
            return
        except (OSError, asyncio.TimeoutError):
            await asyncio.sleep(0.3)
    raise TimeoutError(f"port {port} did not open")


class DesktopManager:
    def __init__(self) -> None:
        self.desktops: dict[str, Desktop] = {}
        self.secondary: dict[str, Desktop] = {}
        self._display_lock = asyncio.Lock()
        self.tokens = TokenBook()
        self._locks: dict[str, asyncio.Lock] = {}

    def lock_for(self, bot_id: str) -> asyncio.Lock:
        if bot_id not in self._locks:
            self._locks[bot_id] = asyncio.Lock()
        return self._locks[bot_id]

    def save(self) -> None:
        STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "desktops": [
                {"bot_id": d.bot_id, "display": d.display, "name": d.name}
                for d in self.desktops.values()
            ]
        }
        STATE_PATH.write_text(json.dumps(payload))

    def load(self) -> list[dict]:
        if not STATE_PATH.exists():
            return []
        try:
            return json.loads(STATE_PATH.read_text()).get("desktops", [])
        except json.JSONDecodeError:
            return []

    async def ensure(self, bot_id: str, display: int, name: str, chrome: bool) -> Desktop:
        async with self.lock_for(bot_id):
            current = self.desktops.get(bot_id)
            if current is None:
                async with self._display_lock:
                    if display < 1 or any(d.display == display for d in [*self.desktops.values(), *self.secondary.values()]):
                        raise ValueError("display already assigned or invalid")
                    current = Desktop(bot_id=bot_id, display=display, name=name)
                    await self._spawn_display(current)
                    self.desktops[bot_id] = current
            current.name = name or current.name
            if chrome and not current.chrome:
                await self._spawn_chrome(current)
                current.chrome = True
            self._prepare_workspace(bot_id)
            self.save()
            return current

    async def restore_all(self) -> None:
        for row in self.load():
            await self.ensure(row["bot_id"], int(row["display"]), row.get("name") or "Teammate", chrome=True)

    def _prepare_workspace(self, bot_id: str) -> None:
        workspace.prepare(bot_id)

    async def _spawn_display(self, desk: Desktop) -> None:
        width, height = geometry()
        bits = depth()
        n = desk.display
        uid, root, home = workspace.prepare(desk.bot_id)
        ident = _as_bot(uid)
        _write_service(
            f"xvfb-{n}",
            "#!/bin/sh\nexec 2>&1\n"
            "export MALLOC_ARENA_MAX=2\n"
            f"exec /command/s6-setuidgid desk Xvfb :{n} -screen 0 {width}x{height}x{bits} "
            "-dpi 96 -nolisten tcp -noreset -ac\n",
        )
        _write_service(
            f"wm-{n}",
            "#!/bin/sh\nexec 2>&1\n"
            f"export DISPLAY=:{n}\nexport HOME={home}\nexport BOT_ROOT={root}\nexport BOT_ID={workspace.safe_id(desk.bot_id)}\n"
            "export MALLOC_ARENA_MAX=2\n"
            "i=0\nwhile [ \"$i\" -lt 100 ]; do\n"
            "  xdpyinfo -display \"$DISPLAY\" >/dev/null 2>&1 && break\n"
            "  i=$((i+1)); sleep 0.1\n"
            "done\n"
            f"xsetroot -display :{n} -solid '#0b1220' || true\n"
            f"exec {ident} dbus-run-session -- /opt/desk/bin/start-wm :{n}\n",
        )
        _write_service(
            f"panels-{n}",
            "#!/bin/sh\nexec 2>&1\n"
            f"export DISPLAY=:{n}\nexport HOME={home}\nexport BOT_ROOT={root}\nexport BOT_ID={workspace.safe_id(desk.bot_id)}\n"
            "export MALLOC_ARENA_MAX=2\n"
            "i=0\nwhile [ \"$i\" -lt 100 ]; do\n"
            "  xdpyinfo -display \"$DISPLAY\" >/dev/null 2>&1 && break\n"
            "  i=$((i+1)); sleep 0.1\n"
            "done\n"
            f"exec {ident} /opt/desk/bin/start-panels :{n}\n",
        )
        _write_service(
            f"vncview-{n}",
            "#!/bin/sh\nexec 2>&1\n"
            f"export DISPLAY=:{n}\n"
            "i=0\nwhile [ \"$i\" -lt 100 ]; do\n"
            "  xdpyinfo -display \"$DISPLAY\" >/dev/null 2>&1 && break\n"
            "  i=$((i+1)); sleep 0.1\n"
            "done\n"
            "exec /command/s6-setuidgid desk x11vnc "
            f"-display :{n} -forever -shared -nopw -viewonly -noremote "
            f"-rfbport {view_port(n)} -noxdamage -wait 10 -defer 10\n",
            down=True,
        )
        _write_service(
            f"vncrw-{n}",
            "#!/bin/sh\nexec 2>&1\n"
            f"export DISPLAY=:{n}\n"
            "i=0\nwhile [ \"$i\" -lt 100 ]; do\n"
            "  xdpyinfo -display \"$DISPLAY\" >/dev/null 2>&1 && break\n"
            "  i=$((i+1)); sleep 0.1\n"
            "done\n"
            "exec /command/s6-setuidgid desk x11vnc "
            f"-display :{n} -forever -shared -nopw -noremote "
            f"-rfbport {rw_port(n)} -noxdamage\n",
            down=True,
        )
        await _rescan()
        await asyncio.sleep(0.4)
        await _wait_x(n)

    async def _spawn_chrome(self, desk: Desktop) -> None:
        n = desk.display
        profile = Path("/data/profiles") / desk.bot_id
        profile.mkdir(parents=True, exist_ok=True)
        uid, root, home = workspace.prepare(desk.bot_id)
        if os.geteuid() == 0:
            os.chown(profile, uid, uid)
            os.chmod(profile, 0o700)
        for stale in ("SingletonLock", "SingletonSocket", "SingletonCookie"):
            path = profile / stale
            if path.exists() or path.is_symlink():
                path.unlink()
        binary = chrome_bin()
        start = "http://127.0.0.1:8099/desktop.html?name=" + desk.name.replace(" ", "%20")
        width, height = geometry()
        _write_service(
            f"chrome-{n}",
            "#!/bin/sh\nexec 2>&1\n"
            f"export DISPLAY=:{n}\nexport HOME={home}\nexport BOT_ROOT={root}\nexport BOT_ID={workspace.safe_id(desk.bot_id)}\n"
            "i=0\nwhile [ \"$i\" -lt 100 ]; do\n"
            "  xdpyinfo -display \"$DISPLAY\" >/dev/null 2>&1 && break\n"
            "  i=$((i+1)); sleep 0.1\n"
            "done\n"
            "export MALLOC_ARENA_MAX=2\n"
            f"exec {_as_bot(uid)} {binary} "
            f"--user-data-dir={profile} "
            "--remote-debugging-address=0.0.0.0 "
            "--remote-allow-origins=* "
            f"--remote-debugging-port={cdp_port(n)} "
            f"--window-size={width},{height} --window-position=0,0 --start-maximized "
            "--disable-session-crashed-bubble --hide-crash-restore-bubble "
            "--ozone-platform=x11 "
            + " ".join(CHROME_FLAGS)
            + f" '{start}'\n",
        )
        await _rescan()
        await asyncio.sleep(0.3)
        await _svc("-u", f"/run/service/chrome-{n}")
        await _wait_port(cdp_port(n))
        # Idle desktop = wallpaper + dock. The window is restored when the bot uses the browser.
        desk.hidden = True
        asyncio.get_running_loop().create_task(self._hide_when_idle(desk))

    async def _hide_when_idle(self, desk: Desktop) -> None:
        # Chromium re-raises itself once its first page loads, so hide it a few times early on.
        for delay in (0, 5, 12):
            if delay:
                await asyncio.sleep(delay)
            if not desk.hidden:
                return
            await self._browser_window(desk.display, "hide")

    async def _browser_window(self, n: int, action: str) -> None:
        env = dict(os.environ, DISPLAY=f":{n}")
        try:
            proc = await asyncio.create_subprocess_exec(
                "/opt/desk/bin/browser-window", action, env=env,
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            )
            await asyncio.wait_for(proc.wait(), timeout=40)
        except Exception:
            pass

    async def show_browser(self, bot_id: str) -> None:
        desk = self.desktops.get(bot_id)
        if desk is None or not desk.hidden:
            return
        desk.hidden = False
        await self._browser_window(desk.display, "show")

    async def restart_chrome(self, bot_id: str) -> None:
        desk = self.desktops[bot_id]
        service = f"/run/service/chrome-{desk.display}"
        if not Path(service).exists():
            await self._spawn_chrome(desk)
        else:
            await _svc("-r", service)
            await _wait_port(cdp_port(desk.display))
            desk.hidden = False
        desk.chrome = True

    def list_displays(self, bot_id: str) -> list[dict]:
        if bot_id not in self.desktops:
            raise KeyError(bot_id)
        width, height = geometry()
        count = 2 if os.environ.get("COMPUTER_SECOND_DISPLAY", "true").lower() == "true" else 1
        return [{"display": n, "width": width, "height": height,
                 "ready": n == 1 or bot_id in self.secondary} for n in range(1, count + 1)]

    async def select_display(self, bot_id: str, display: int = 1) -> Desktop:
        if display not in (1, 2):
            raise ValueError("display must be 1 or 2")
        primary = self.desktops[bot_id]
        if display == 1:
            return primary
        if os.environ.get("COMPUTER_SECOND_DISPLAY", "true").lower() != "true":
            raise ValueError("second display is disabled")
        async with self.lock_for(bot_id):
            if bot_id not in self.secondary:
                async with self._display_lock:
                    used = {d.display for d in [*self.desktops.values(), *self.secondary.values()]}
                    physical = next(n for n in range(2, 1000) if n not in used)
                    desk = Desktop(bot_id, physical, primary.name, primary.holder, primary.epoch)
                    await self._spawn_display(desk)
                    desk.holder, desk.epoch = primary.holder, primary.epoch
                    self.secondary[bot_id] = desk
            return self.secondary[bot_id]

    async def native_command(self, bot_id: str, display: int, argv: list[str], data: bytes | None = None) -> bytes:
        import shlex
        desk = await self.select_display(bot_id, display)
        if self.desktops[bot_id].holder != "agent":
            raise PermissionError("human holds control")
        uid, _root, home = workspace.prepare(bot_id)
        proc = await asyncio.create_subprocess_exec(
            *shlex.split(_as_bot(uid)), *argv,
            env={"DISPLAY": f":{desk.display}", "HOME": str(home), "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"},
            stdin=asyncio.subprocess.PIPE if data is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        try:
            output, _ = await asyncio.wait_for(proc.communicate(data), timeout=15)
        except BaseException:
            proc.kill()
            await proc.wait()
            raise
        if proc.returncode:
            raise RuntimeError("desktop command failed")
        return output

    async def set_viewer(self, bot_id: str, up: bool, display: int = 1) -> None:
        if not up and display == 1 and bot_id in self.secondary:
            await self.set_viewer(bot_id, False, 2)
        desk = await self.select_display(bot_id, display)
        service = f"/run/service/vncview-{desk.display}"
        if not Path(service).exists():
            raise RuntimeError("view vnc service missing")
        term = f"/run/service/xterm-{desk.display}"
        if up:
            if Path(term).exists():
                await _svc("-U", term)
            port = view_port(desk.display)
            if not _port_open(port):
                # s6 -U does not replace a service that is already up. A wedged
                # x11vnc keeps the port bound and ignores SIGTERM, so the listen
                # socket stops accepting. SIGKILL is what actually restarts it.
                await _svc("-k", service)
                await _svc("-U", service)
                await _wait_port(port, timeout=12)
            return
        port = view_port(desk.display)
        if _port_open(port):
            await _svc("-D", service)
            await asyncio.sleep(0.3)
            if _port_open(port):
                await _svc("-k", service)
        if Path(term).exists():
            await _svc("-d", term)

    async def set_holder(self, bot_id: str, holder: str, epoch: int) -> None:
        for desk in [self.desktops[bot_id], *([self.secondary[bot_id]] if bot_id in self.secondary else [])]:
            await self._set_display_holder(desk, holder, epoch)

    async def _set_display_holder(self, desk: Desktop, holder: str, epoch: int) -> None:
        desk.holder = holder
        desk.epoch = epoch
        service = f"/run/service/vncrw-{desk.display}"
        if holder == "human":
            if not Path(service).exists():
                raise RuntimeError("rw vnc service missing")
            await _svc("-U", service)
            await _wait_port(rw_port(desk.display), timeout=15)
        else:
            rw_target = f"127.0.0.1:{rw_port(desk.display)}"
            self.tokens.entries = {k: v for k, v in self.tokens.entries.items() if v != rw_target}
            self.tokens.flush()
            if Path(service).exists():
                await _svc("-d", service)
                await asyncio.sleep(0.4)

    def _uid(self) -> int:
        import pwd
        return pwd.getpwnam("desk").pw_uid

    def _gid(self) -> int:
        import grp
        return grp.getgrnam("desk").gr_gid

    def status(self, bot_id: str, display: int = 1) -> dict:
        desk = self.desktops.get(bot_id) if display == 1 else self.secondary.get(bot_id)
        if desk is None:
            return {"ready": False}
        rw_up = _port_open(rw_port(desk.display))
        return {
            "ready": True,
            "botId": desk.bot_id,
            "display": desk.display,
            "holder": desk.holder,
            "epoch": desk.epoch,
            "chrome": desk.chrome and _port_open(cdp_port(desk.display)),
            "viewPort": view_port(desk.display),
            "rwPort": rw_port(desk.display),
            "rwRunning": rw_up,
            "cdpPort": cdp_port(desk.display),
        }


def _as_bot(uid: int) -> str:
    return f"setpriv --reuid {uid} --regid {uid} --clear-groups --inh-caps=-all"


def _port_open(port: int) -> bool:
    import socket
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.3):
            return True
    except OSError:
        return False
