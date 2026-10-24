"""Per-bot Xvfb + xfwm4 + picom + Plank + on-demand x11vnc + Chrome supervision via s6-overlay."""
from __future__ import annotations

import asyncio
import json
import os
import shlex
from dataclasses import dataclass, field
from pathlib import Path

import workspace
from box_contract import MAX_WINDOWS, port_for
from browser_flags import chrome_egress_flags

S6_SCAN = "/command/s6-svscanctl"
S6_SVC = "/command/s6-svc"
STATE_PATH = Path("/data/state/desktops.json")
CDP_ACTIVITY_DIR = Path("/run/desk")
DESKTOP_SERVICES = ("chrome", "vncrw", "vncview", "xterm", "panels", "wm", "xvfb")


def lazy_default() -> bool:
    """Computers start with no desktop unless DESKTOP_LAZY=false."""
    return os.environ.get("DESKTOP_LAZY", "true").strip().lower() not in {"0", "false", "no"}


def idle_seconds() -> int:
    try:
        return max(30, int(os.environ.get("DESKTOP_IDLE_SECONDS", "300")))
    except ValueError:
        return 300


def cdp_activity(display: int) -> float:
    """When the CDP proxy last carried traffic for this display (file mtime, monotonic-free)."""
    try:
        return (CDP_ACTIVITY_DIR / f"cdp-{display}").stat().st_mtime
    except OSError:
        return 0.0


def _has_client(port: int) -> bool:
    """True when an established TCP connection is using this local port (somebody is watching).
    A listening VNC server with no viewer does not count."""
    for table in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            with open(table) as handle:
                next(handle, None)
                for line in handle:
                    fields = line.split()
                    if len(fields) > 3 and fields[3] == "01" and int(fields[1].rsplit(":", 1)[1], 16) == port:
                        return True
        except (OSError, ValueError, IndexError):
            continue
    return False


def _now() -> float:
    import time
    return time.time()


@dataclass
class Desktop:
    bot_id: str
    display: int
    name: str = "Teammate"
    holder: str = "agent"
    epoch: int = 1
    chrome: bool = False
    hidden: bool = False
    # Headless by default: a desktop is registered (lease, fence, status work) but its
    # Xvfb, window manager, dock and Chrome only run while `awake`.
    awake: bool = True
    last_use: float = 0.0


class StaleDesktopEpoch(PermissionError):
    def __init__(self, holder: str, epoch: int):
        super().__init__("stale desktop fencing epoch")
        self.holder = holder
        self.epoch = epoch


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
    "--disable-gpu-compositing",
    "--in-process-gpu",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-webgl",
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
) + chrome_egress_flags()


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
    return int(override) + display - 1 if override else port_for("cdp", display)


def view_port(display: int) -> int:
    override = os.environ.get("VNC_VIEW_PORT", "").strip()
    return int(override) + display - 1 if override else port_for("vnc", display)


def rw_port(display: int) -> int:
    override = os.environ.get("VNC_RW_PORT", "").strip()
    return int(override) + display - 1 if override else 6900 + display - 1


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
        self.windows: dict[tuple[str, int], Desktop] = {}
        self._display_lock = asyncio.Lock()
        self._active_processes: dict[int, set[asyncio.subprocess.Process]] = {}
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
                {"bot_id": d.bot_id, "display": d.display, "name": d.name, "window": 1}
                for d in self.desktops.values()
            ] + [
                {"bot_id": d.bot_id, "display": d.display, "name": d.name, "window": logical}
                for (bot_id, logical), d in self.windows.items() if logical != 2
            ] + [
                {"bot_id": bot_id, "display": d.display, "name": d.name, "window": 2}
                for bot_id, d in self.secondary.items()
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

    async def ensure(self, bot_id: str, display: int, name: str, chrome: bool, lazy: bool = False) -> Desktop:
        async with self.lock_for(bot_id):
            current = self.desktops.get(bot_id)
            if current is None:
                async with self._display_lock:
                    if display < 1 or any(d.display == display for d in [*self.desktops.values(), *self.secondary.values(), *self.windows.values()]):
                        raise ValueError("display already assigned or invalid")
                    current = Desktop(bot_id=bot_id, display=display, name=name, awake=not lazy)
                    if not lazy:
                        await self._spawn_display(current)
                    self.desktops[bot_id] = current
            elif not lazy and not current.awake:
                await self._wake_locked(current)
            current.name = name or current.name
            if chrome and current.awake and not current.chrome:
                await self._spawn_chrome(current)
                current.chrome = True
            if current.awake:
                current.last_use = _now()
            self._prepare_workspace(bot_id)
            self.save()
            return current

    def is_awake(self, bot_id: str) -> bool:
        desk = self.desktops.get(bot_id)
        return bool(desk and desk.awake)

    def touch(self, bot_id: str) -> None:
        desk = self.desktops.get(bot_id)
        if desk is not None and desk.awake:
            desk.last_use = _now()

    async def wake(self, bot_id: str) -> bool:
        """Start the desktop and Chrome for a browser or desktop call, Watch or Take control.
        Returns True when this call started it."""
        desk = self.desktops.get(bot_id)
        if desk is None:
            raise KeyError(bot_id)
        if desk.awake:
            desk.last_use = _now()
            return False
        async with self.lock_for(bot_id):
            if desk.awake:
                return False
            await self._wake_locked(desk)
            return True

    async def _wake_locked(self, desk: Desktop) -> None:
        await self._spawn_display(desk)
        for service in ("xvfb", "wm", "panels"):
            await _svc("-u", f"/run/service/{service}-{desk.display}")
        await _wait_x(desk.display)
        await self._spawn_chrome(desk)
        desk.chrome = True
        desk.awake = True
        desk.last_use = _now()
        print(json.dumps({"level": "info", "msg": "desktop woke", "display": desk.display}), flush=True)

    async def sleep_desktop(self, bot_id: str) -> bool:
        """Stop Chrome, then the desktop. The computer, its files and its jobs keep running."""
        desk = self.desktops.get(bot_id)
        if desk is None or not desk.awake:
            return False
        async with self.lock_for(bot_id):
            if not desk.awake:
                return False
            for extra in [n for (owner, n) in list(self.windows) if owner == bot_id] + ([2] if bot_id in self.secondary else []):
                try:
                    await self.destroy(bot_id, extra)
                except ValueError:
                    pass
            n = desk.display
            for service in DESKTOP_SERVICES:
                path = Path("/run/service") / f"{service}-{n}"
                if path.exists():
                    (path / "down").write_text("")
                    await _svc("-d", str(path))
            await asyncio.sleep(1.0)
            for service in DESKTOP_SERVICES:
                path = Path("/run/service") / f"{service}-{n}"
                if path.exists():
                    await _svc("-k", str(path))
            desk.awake = False
            desk.chrome = False
            desk.hidden = False
            self.save()
            print(json.dumps({"level": "info", "msg": "desktop asleep", "display": n}), flush=True)
            return True

    def idle_desktops(self, now: float | None = None, limit: int | None = None) -> list[str]:
        """Awake desktops nobody has used, watched or controlled for `limit` seconds."""
        now = _now() if now is None else now
        limit = idle_seconds() if limit is None else limit
        idle = []
        for bot_id, desk in self.desktops.items():
            if not desk.awake or desk.holder != "agent":
                continue
            last = max(desk.last_use, cdp_activity(desk.display))
            if now - last < limit:
                continue
            if _has_client(view_port(desk.display)) or _has_client(rw_port(desk.display)):
                # Somebody is watching: that counts as use.
                desk.last_use = now
                continue
            idle.append(bot_id)
        return idle

    async def restore_all(self) -> None:
        rows = self.load()
        lazy = lazy_default()
        for row in rows:
            if int(row.get("window", 1)) == 1:
                await self.ensure(row["bot_id"], int(row["display"]), row.get("name") or "Teammate", chrome=True, lazy=lazy)
        if lazy:
            # Extra windows reopen on demand; a restart does not bring up any desktop.
            if rows:
                self.save()
            return
        for row in rows:
            window = int(row.get("window", 1))
            if window > 1:
                desk = await self.select_display(row["bot_id"], window)
                await self._spawn_chrome(desk)
                desk.chrome = True
        if rows:
            self.save()

    def _prepare_workspace(self, bot_id: str) -> None:
        workspace.desktop_identity(bot_id)

    async def _spawn_display(self, desk: Desktop) -> None:
        width, height = geometry()
        bits = depth()
        n = desk.display
        uid, root, home = workspace.desktop_identity(desk.bot_id)
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
            f"export DISPLAY=:{n}\nexport HOME={home}\nexport BOT_ROOT={root}\nexport BOT_ID={root.name}\n"
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
            f"export DISPLAY=:{n}\nexport HOME={home}\nexport BOT_ROOT={root}\nexport BOT_ID={root.name}\n"
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
        uid, root, home = workspace.desktop_identity(desk.bot_id)
        profile = workspace.profile_dir(desk.bot_id)
        profile.mkdir(parents=True, exist_ok=True)
        if os.geteuid() == 0:
            if profile.stat().st_uid != uid:
                workspace._own(profile, uid)
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
            f"export DISPLAY=:{n}\nexport HOME={home}\nexport BOT_ROOT={root}\nexport BOT_ID={root.name}\n"
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
            + " ".join(shlex.quote(flag) for flag in CHROME_FLAGS)
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
        # Wait for the window, then hide it a few times: Chromium re-raises itself once its first
        # page loads. Every pass checks `desk.hidden`, so a bot that starts using the browser
        # first is never hidden again.
        for _ in range(60):
            if not desk.hidden:
                return
            if await self._browser_window(desk.display, "hide") == 0:
                break
            await asyncio.sleep(0.5)
        else:
            return
        for delay in (5, 7):
            await asyncio.sleep(delay)
            if not desk.hidden:
                return
            await self._browser_window(desk.display, "hide")

    async def _browser_window(self, n: int, action: str) -> int:
        env = dict(os.environ, DISPLAY=f":{n}")
        try:
            proc = await asyncio.create_subprocess_exec(
                "/opt/desk/bin/browser-window", action, env=env,
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            )
            return await asyncio.wait_for(proc.wait(), timeout=40)
        except Exception:
            return 1

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
        # The second display is a lazy v0.4 capability. Additional windows are
        # listed only once opened; MAX_WINDOWS is a capacity, not an allocation.
        displays = {1}
        second_enabled = os.environ.get("COMPUTER_SECOND_DISPLAY", "true").lower() == "true"
        if second_enabled:
            displays.add(2)
        displays.update(n for owner, n in self.windows if owner == bot_id and (n != 2 or second_enabled))
        return [{"display": n, "width": width, "height": height,
                 "ready": n == 1 or (bot_id, n) in self.windows or (n == 2 and bot_id in self.secondary)}
                for n in sorted(displays)]

    async def select_display(self, bot_id: str, display: int = 1) -> Desktop:
        if isinstance(display, bool) or not isinstance(display, int) or not 1 <= display <= MAX_WINDOWS:
            raise ValueError("display must be between 1 and MAX_WINDOWS")
        primary = self.desktops[bot_id]
        if display == 1:
            return primary
        if display == 2 and os.environ.get("COMPUTER_SECOND_DISPLAY", "true").lower() != "true":
            raise ValueError("second display is disabled")
        async with self.lock_for(bot_id):
            key = (bot_id, display)
            existing = self.windows.get(key) or (self.secondary.get(bot_id) if display == 2 else None)
            if existing is None:
                async with self._display_lock:
                    used = {d.display for d in [*self.desktops.values(), *self.secondary.values()]}
                    used.update(d.display for d in self.windows.values())
                    physical = next((n for n in range(1, MAX_WINDOWS + 1) if n not in used), None)
                    if physical is None:
                        raise ValueError("maximum windows reached")
                    desk = Desktop(bot_id, physical, primary.name, primary.holder, primary.epoch)
                    await self._spawn_display(desk)
                    desk.holder, desk.epoch = primary.holder, primary.epoch
                    self.windows[key] = desk
                    if display == 2:
                        self.secondary[bot_id] = desk
                    existing = desk
            return existing

    async def destroy(self, bot_id: str, display: int) -> None:
        if display == 1:
            raise ValueError("primary window cannot be destroyed")
        desk = self.windows.pop((bot_id, display), None)
        if desk is None and display == 2:
            desk = self.secondary.pop(bot_id, None)
        elif display == 2:
            self.secondary.pop(bot_id, None)
        if desk is None:
            return
        for service in (f"chrome-{desk.display}", f"vncrw-{desk.display}", f"vncview-{desk.display}",
                        f"panels-{desk.display}", f"wm-{desk.display}", f"xvfb-{desk.display}"):
            path = f"/run/service/{service}"
            if Path(path).exists():
                await _svc("-k", path)
        await _rescan()
        self.save()

    async def native_command(self, bot_id: str, display: int, argv: list[str], data: bytes | None = None,
                             actor_id: str | None = None, epoch: int | None = None) -> bytes:
        import shlex
        desk = await self.select_display(bot_id, display)
        if self.desktops[bot_id].holder != "agent":
            if actor_id is not None:
                raise StaleDesktopEpoch(self.desktops[bot_id].holder, self.desktops[bot_id].epoch)
            raise PermissionError("human holds control")
        if actor_id is not None and (epoch != desk.epoch or desk.holder != "agent"):
            raise StaleDesktopEpoch(desk.holder, desk.epoch)
        if actor_id is None and desk.holder not in {"agent", "human"}:
            raise PermissionError("desktop is fenced")
        uid, _root, home = workspace.desktop_identity(bot_id)
        proc = await asyncio.create_subprocess_exec(
            *shlex.split(_as_bot(uid)), *argv,
            env={"DISPLAY": f":{desk.display}", "HOME": str(home), "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"},
            stdin=asyncio.subprocess.PIPE if data is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, start_new_session=True)
        self._active_processes.setdefault(desk.display, set()).add(proc)
        try:
            output, _ = await asyncio.wait_for(proc.communicate(data), timeout=15)
        except asyncio.TimeoutError as exc:
            await self._terminate_process(proc)
            raise RuntimeError("desktop command timed out") from exc
        except BaseException:
            await self._terminate_process(proc)
            raise
        finally:
            self._active_processes.get(desk.display, set()).discard(proc)
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
        extras = [desk for (owner, _), desk in self.windows.items() if owner == bot_id and desk is not self.desktops[bot_id]]
        if bot_id in self.secondary and self.secondary[bot_id] not in extras:
            extras.append(self.secondary[bot_id])
        desks = [self.desktops[bot_id], *extras]
        for desk in desks:
            await self._set_display_holder(desk, holder, epoch)

    async def _set_display_holder(self, desk: Desktop, holder: str, epoch: int) -> None:
        if holder not in {"agent", "human", "fenced"} or epoch < 0:
            raise ValueError("invalid desktop holder")
        if epoch == desk.epoch and holder == desk.holder:
            return
        if epoch <= desk.epoch:
            raise StaleDesktopEpoch(desk.holder, desk.epoch)
        # Fence local state before touching services. On failure the desktop remains
        # closed to agent actions until a later API reconciliation succeeds.
        old_holder, old_epoch = desk.holder, desk.epoch
        desk.holder = "fenced"
        desk.epoch = epoch
        if holder == "human" and old_holder == "agent":
            await self._cancel_display_actions(desk)
        desk.holder = holder
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

    async def _cancel_display_actions(self, desk: Desktop) -> None:
        # The active command runner owns process groups and terminates them on
        # cancellation. Release every modifier and button before enabling RW VNC.
        active = tuple(self._active_processes.get(desk.display, ()))
        for proc in active:
            await self._terminate_process(proc)
        cleanup = (["xdotool", "keyup", key] for key in ("Shift_L", "Control_L", "Alt_L", "Super_L", "Shift_R", "Control_R", "Alt_R", "Super_R"))
        cleanup = [*cleanup, *( ["xdotool", "mouseup", button] for button in ("1", "2", "3") )]
        await asyncio.gather(*(self._raw_input(desk, command) for command in cleanup), return_exceptions=True)

    @staticmethod
    async def _terminate_process(proc: asyncio.subprocess.Process) -> None:
        import os
        import signal
        if proc.returncode is not None:
            return
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            await asyncio.wait_for(proc.wait(), timeout=2)
        except asyncio.TimeoutError:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            await proc.wait()

    async def _raw_input(self, desk: Desktop, argv: list[str]) -> None:
        import shlex
        uid, _root, home = workspace.desktop_identity(desk.bot_id)
        proc = await asyncio.create_subprocess_exec(
            *shlex.split(_as_bot(uid)), *argv,
            env={"DISPLAY": f":{desk.display}", "HOME": str(home), "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"},
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        try:
            await asyncio.wait_for(proc.wait(), timeout=0.5)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            proc.kill()
            await proc.wait()

    def _uid(self) -> int:
        import pwd
        return pwd.getpwnam("desk").pw_uid

    def _gid(self) -> int:
        import grp
        return grp.getgrnam("desk").gr_gid

    def status(self, bot_id: str, display: int = 1) -> dict:
        desk = self.desktops.get(bot_id) if display == 1 else (self.windows.get((bot_id, display)) or (self.secondary.get(bot_id) if display == 2 else None))
        if desk is None:
            return {"ready": False}
        primary = self.desktops.get(bot_id)
        awake = primary.awake if primary is not None else desk.awake
        rw_up = awake and _port_open(rw_port(desk.display))
        return {
            "ready": True,
            "desktop": "on" if awake else "asleep",
            "idleSeconds": int(max(0.0, _now() - max(desk.last_use, cdp_activity(desk.display)))) if awake else None,
            "botId": desk.bot_id,
            "display": desk.display,
            "holder": desk.holder,
            "epoch": desk.epoch,
            "chrome": awake and desk.chrome and _port_open(cdp_port(desk.display)),
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
