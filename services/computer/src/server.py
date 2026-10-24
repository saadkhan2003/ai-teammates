"""Computer manager: desktops, browser, files, and a view-only/control VNC token map."""
from __future__ import annotations

import asyncio
import json
import importlib.util
import base64
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException, Request, Query
from fastapi.responses import FileResponse, Response
import workspace
from browser import BrowserHub, run_command
from desktops import DesktopManager, StaleDesktopEpoch, cdp_port, geometry, rw_port, view_port
from fixtureserver import start as start_fixtures
from pure import redact, scrub_tree
from private_browser import PrivateBrowser, load_host_suffixes, private_browser_url_allowed, replace_host_suffixes
from box_contract import TAILNET_CHROME_CDP
from urllib.parse import quote
import httpx
from box_contract import MAX_WINDOWS, PATHS
from recorder import Recorder, RecorderConflict
from desktop_fencing import ActionOutcome, DesktopFence, LeaseConflict, LeaseSnapshot

manager = DesktopManager()
hub: BrowserHub | None = None
teach_recorder: Recorder | None = None
private_browser: PrivateBrowser | None = None
fences: dict[str, DesktopFence] = {}


def _fence(bot_id: str) -> DesktopFence:
    fence = fences.get(bot_id)
    if fence is None:
        async def release_inputs():
            recording = recordings.get(bot_id)
            if recording is not None and recording[0].returncode is None:
                recording[0].kill()
                await recording[0].wait()
            desk = manager.desktops.get(bot_id)
            if desk is not None:
                await manager._cancel_display_actions(desk)
        fence = DesktopFence(release_held=release_inputs)
        fences[bot_id] = fence
    return fence
from computer_tools import ffmpeg_argv, safe_recording_name, scale_point, validate_keys
from library_thumbnail import generate_thumbnail
recordings: dict[str, tuple[asyncio.subprocess.Process, Path, float, Path]] = {}


def require_token(authorization: str = Header(default="")) -> None:
    expected = os.environ.get("COMPUTER_TOKEN", "")
    presented = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
    if not expected or not presented or not _eq(presented, expected):
        raise HTTPException(status_code=401, detail="unauthorized")


def _eq(left: str, right: str) -> bool:
    import hmac
    return hmac.compare_digest(left, right)


async def agent_allowed(bot_id: str, body: dict, action_path: str = "agent-action") -> tuple[str, int]:
    desk = manager.desktops.get(bot_id)
    if desk is None:
        raise HTTPException(status_code=404, detail="desktop not ready")
    actor_id = body.get("actor_id", body.get("actorId"))
    epoch = body.get("epoch")
    if (not isinstance(actor_id, str) or not actor_id or len(actor_id) > 128 or
            not isinstance(epoch, int) or isinstance(epoch, bool) or epoch != desk.epoch or
            desk.holder != "agent"):
        raise HTTPException(status_code=409, detail={"code": "DESKTOP_BUSY", "holder": desk.holder, "epoch": desk.epoch})
    try:
        await _fence(bot_id).authorize_effect(action_path, actor_id, epoch)
    except LeaseConflict as exc:
        raise HTTPException(status_code=409, detail={"code": "DESKTOP_BUSY", "message": "You're in control — tell me when to continue", "epoch": exc.current.epoch}) from exc
    return actor_id, epoch


@asynccontextmanager
async def lifespan(app: FastAPI):
    global hub, private_browser
    start_fixtures()
    hub = BrowserHub(manager)
    pty_spec = importlib.util.spec_from_file_location("computer_terminal_pty", Path(__file__).with_name("pty.py"))
    assert pty_spec is not None and pty_spec.loader is not None
    terminal_pty = importlib.util.module_from_spec(pty_spec)
    pty_spec.loader.exec_module(terminal_pty)
    terminal_task = asyncio.create_task(terminal_pty.serve_all())
    private_browser = PrivateBrowser(
        profile=os.environ.get("PRIVATE_BROWSER_PROFILE", "/home/box/private"),
        mountinfo=None,
        trusted_session=os.environ.get("BOX_UNTRUSTED_TURN_CLONE") != "1",
    )
    try:
        await manager.restore_all()
        computer_id = os.environ.get("COMPUTER_ID", "").strip()
        if computer_id and computer_id not in manager.desktops:
            display = int(os.environ.get("DISPLAY_NUM", "1"))
            name = os.environ.get("COMPUTER_NAME", "Teammate")
            await manager.ensure(computer_id, display, name, True)
    except Exception as exc:
        print(json.dumps({"level": "error", "msg": "restore failed", "error": str(exc)}), flush=True)
    yield
    for process, _path, _started, _root in recordings.values():
        if process.returncode is None:
            process.kill()
            await process.wait()
    recordings.clear()
    terminal_task.cancel()
    try:
        await terminal_task
    except asyncio.CancelledError:
        pass
    if private_browser is not None:
        private_browser.stop()
    await hub.close()


app = FastAPI(lifespan=lifespan)


@app.post("/library/thumbnail")
async def library_thumbnail(request: Request, kind: str = Query(...), _: None = Depends(require_token)):
    if kind not in {"image", "video", "pdf"}:
        raise HTTPException(status_code=400, detail="unsupported kind")
    data = await request.body()
    if len(data) > 50_000_000:
        raise HTTPException(status_code=413, detail="blob too large")
    try:
        result = generate_thumbnail(data, kind)
    except ValueError:
        raise HTTPException(status_code=422, detail="thumbnail generation failed")
    return Response(content=result, media_type="image/webp", headers={"Cache-Control": "no-store"})
@app.post("/private-browser/start")
async def private_browser_start(_: None = Depends(require_token)):
    if private_browser is None:
        raise HTTPException(status_code=503, detail="private browser unavailable")
    try:
        process = private_browser.start()
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail="private browser unavailable for untrusted session") from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail="private browser requires a tmpfs profile") from exc
    return {"ok": True, "port": TAILNET_CHROME_CDP, "running": process.poll() is None}


@app.post("/private-browser/open")
async def private_browser_open(body: dict, _: None = Depends(require_token)):
    if private_browser is None:
        raise HTTPException(status_code=503, detail="private browser unavailable")
    url = body.get("url")
    hosts = load_host_suffixes(os.environ.get("PRIVATE_HOST_SUFFIXES_FILE", "/tmp/private-host-suffixes"))
    if not private_browser_url_allowed(url, hosts):
        raise HTTPException(status_code=403, detail="private host is not allowed")
    try:
        private_browser.start()
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.put(f"http://127.0.0.1:{TAILNET_CHROME_CDP}/json/new?{quote(url, safe='')}")
            response.raise_for_status()
            target = response.json()
        return {"ok": True, "targetId": str(target.get("id", "")), "url": url}
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail="private browser unavailable for untrusted session") from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail="private browser requires a tmpfs profile") from exc
    except (httpx.HTTPError, ValueError, KeyError) as exc:
        raise HTTPException(status_code=503, detail="private browser is not ready") from exc


@app.post("/private-browser/stop")
async def private_browser_stop(_: None = Depends(require_token)):
    if private_browser is None:
        raise HTTPException(status_code=503, detail="private browser unavailable")
    try:
        private_browser.stop()
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail="private browser unavailable for untrusted session") from exc
    return {"ok": True}


@app.post("/private-browser/wipe")
async def private_browser_wipe(_: None = Depends(require_token)):
    if private_browser is None:
        raise HTTPException(status_code=503, detail="private browser unavailable")
    try:
        private_browser.wipe()
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail="private browser unavailable for untrusted session") from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail="private browser requires a tmpfs profile") from exc
    return {"ok": True}


@app.post("/internal/private-hosts")
async def update_private_hosts(body: dict, _: None = Depends(require_token)):
    hosts = body.get("hosts")
    if not isinstance(hosts, list):
        raise HTTPException(status_code=400, detail="invalid host list")
    try:
        replace_host_suffixes(hosts, os.environ.get("PRIVATE_HOST_SUFFIXES_FILE", "/tmp/private-host-suffixes"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="invalid host list") from exc
    return {"ok": True, "count": len(hosts)}


def _hub() -> BrowserHub:
    if hub is None:
        raise HTTPException(status_code=503, detail="browser runtime not ready")
    return hub


@app.get("/health")
async def health():
    token = Path("/run/desk/secrets/plugin.token")
    display = int(os.environ.get("DISPLAY_NUM", "1"))
    viewer_installed = Path(f"/run/service/vncview-{display}/run").is_file()
    return {
        "ok": True,
        "secretsReady": token.is_file(),
        "x": Path(f"/tmp/.X11-unix/X{display}").exists(),
        "chrome": _port_open(cdp_port(display)),
        # The view server is installed and starts when someone watches.
        "vnc": _port_open(view_port(display)) or viewer_installed,
        "vncRunning": _port_open(view_port(display)),
        "vncRw": _port_open(rw_port(display)),
        "computerId": os.environ.get("COMPUTER_ID", ""),
    }


@app.post("/doctor")
async def doctor_report(_: None = Depends(require_token)):
    from doctor import run_checks
    checks = run_checks()
    return {"ok": all(item["ok"] for item in checks.values()), "checks": checks}


def _port_open(port: int) -> bool:
    import socket
    sock = socket.socket()
    sock.settimeout(0.2)
    try:
        sock.connect(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        sock.close()


@app.get("/metrics")
async def metrics(_: None = Depends(require_token)):
    rss = 0
    chrome = 0
    try:
        for entry in Path("/proc").iterdir():
            if not entry.name.isdigit():
                continue
            try:
                comm = (entry / "comm").read_text().strip()
                statm = (entry / "statm").read_text().split()
                rss += int(statm[1]) * 4096
                if comm in {"chromium", "chrome", "Xvfb", "openbox", "xfwm4", "x11vnc"}:
                    if comm == "chromium":
                        chrome += 1
            except OSError:
                continue
    except OSError:
        pass
    return {"memoryBytes": rss, "chromeProcesses": chrome, "desktops": len(manager.desktops)}


@app.post("/desktops")
async def ensure_desktop(body: dict, _: None = Depends(require_token)):
    bot_id = str(body["botId"])
    display = int(body["display"])
    name = str(body.get("name") or "Teammate")
    chrome = bool(body.get("chrome", True))
    desk = await manager.ensure(bot_id, display, name, chrome)
    if chrome:
        await _hub().connect(bot_id)
    return manager.status(desk.bot_id)


@app.post("/windows/{bot_id}/{display}")
async def start_window(bot_id: str, display: int, body: dict | None = None, _: None = Depends(require_token)):
    if not 1 <= display <= MAX_WINDOWS:
        raise HTTPException(status_code=409, detail="maximum windows reached")
    try:
        desk = await manager.select_display(bot_id, display)
        if body is None or body.get("chrome", True):
            if not desk.chrome:
                await manager._spawn_chrome(desk)
                desk.chrome = True
        manager.save()
        return manager.status(bot_id, display)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail="maximum windows reached") from exc


@app.delete("/windows/{bot_id}/{display}")
async def stop_window(bot_id: str, display: int, _: None = Depends(require_token)):
    try:
        await manager.destroy(bot_id, display)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail="primary window cannot be destroyed") from exc
    (Path(PATHS["windowTokens"]) / str(display)).unlink(missing_ok=True)
    return {"ok": True, "display": display}


@app.post("/windows/{bot_id}/{display}/stop")
async def stop_window_control(bot_id: str, display: int, _: None = Depends(require_token)):
    return await stop_window(bot_id, display, _)


@app.post("/windows/{bot_id}/{display}/owner-token")
async def issue_window_owner_token(bot_id: str, display: int, _: None = Depends(require_token)):
    from window_router import new_owner_token, write_owner_token
    try:
        token = new_owner_token()
        write_owner_token(Path(PATHS["windowTokens"]), display, token)
        return {"display": display, "ownerToken": token}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="invalid display") from exc


@app.delete("/windows/{bot_id}/{display}/owner-token")
async def revoke_window_owner_token(bot_id: str, display: int, _: None = Depends(require_token)):
    path = Path(PATHS["windowTokens"]) / str(display)
    try:
        path.unlink(missing_ok=True)
    except OSError as exc:
        raise HTTPException(status_code=500, detail="unable to revoke token") from exc
    return {"ok": True}


async def selected_display(bot_id: str, display: int):
    try:
        return await manager.select_display(bot_id, display)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="desktop not ready") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


async def native_command(bot_id: str, display: int, argv: list[str], data: bytes | None = None,
                         actor_id: str | None = None, epoch: int | None = None):
    try:
        return await manager.native_command(bot_id, display, argv, data, actor_id, epoch)
    except StaleDesktopEpoch as exc:
        raise HTTPException(status_code=409, detail={"code": "DESKTOP_BUSY", "holder": exc.holder, "epoch": exc.epoch}) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=423, detail="human holds control") from exc


@app.get("/desktops/{bot_id}/displays")
@app.post("/desktops/{bot_id}/displays")
async def list_displays(bot_id: str, _: None = Depends(require_token)):
    try:
        return {"displays": manager.list_displays(bot_id)}
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="desktop not ready") from exc


@app.post("/desktops/{bot_id}/screenshot")
async def desktop_screenshot(bot_id: str, body: dict, display: int = Query(1, ge=1, le=MAX_WINDOWS), _: None = Depends(require_token)):
    actor_id, epoch = await agent_allowed(bot_id, body, "screenshot")
    await selected_display(bot_id, display)
    png = await _fence(bot_id).run_effect("screenshot", actor_id, epoch,
        native_command(bot_id, display, ["import", "-window", "root", "png:-"], actor_id=actor_id, epoch=epoch))
    if isinstance(png, ActionOutcome): return {"code": "DESKTOP_BUSY", "status": png.value}
    return Response(content=png, media_type="image/png")


@app.post("/desktops/{bot_id}/click")
async def desktop_click(bot_id: str, body: dict, display: int = Query(1, ge=1, le=MAX_WINDOWS), _: None = Depends(require_token)):
    actor_id, epoch = await agent_allowed(bot_id, body)
    await selected_display(bot_id, display)
    from desktops import geometry
    width, height = geometry()
    try:
        if isinstance(body["x"], bool) or isinstance(body["y"], bool):
            raise ValueError()
        x, y = float(body["x"]), float(body["y"])
        if body.get("coordinateSpace") == "model":
            width, height = geometry()
            x, y = scale_point(x, y, width, height)
        x, y = int(x), int(y)
        raw_button = body.get("button", 1)
        if isinstance(raw_button, bool) or int(raw_button) != raw_button:
            raise ValueError()
        button = int(raw_button)
        if not (0 <= x < width and 0 <= y < height and button in (1, 2, 3)):
            raise ValueError()
    except (KeyError, ValueError, TypeError) as exc:
        raise HTTPException(status_code=400, detail="invalid coordinates or button") from exc
    result = await _fence(bot_id).run_effect("xdotool", actor_id, epoch, native_command(bot_id, display, ["xdotool", "mousemove", "--sync", str(x), str(y), "click", str(button)], actor_id=actor_id, epoch=epoch))
    if isinstance(result, ActionOutcome): return {"ok": False, "code": "DESKTOP_BUSY", "status": result.value}
    return {"ok": True}


@app.post("/desktops/{bot_id}/key")
async def desktop_key(bot_id: str, body: dict, display: int = Query(1, ge=1, le=MAX_WINDOWS), _: None = Depends(require_token)):
    actor_id, epoch = await agent_allowed(bot_id, body)
    await selected_display(bot_id, display)
    try:
        keys = validate_keys(body.get("keys"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    result = await _fence(bot_id).run_effect("xdotool", actor_id, epoch,
        native_command(bot_id, display, ["xdotool", "key", "--clearmodifiers", *keys], actor_id=actor_id, epoch=epoch))
    if isinstance(result, ActionOutcome): return {"ok": False, "code": "DESKTOP_BUSY", "status": result.value}
    return {"ok": True}


@app.post("/desktops/{bot_id}/scroll")
async def desktop_scroll(bot_id: str, body: dict, display: int = Query(1, ge=1, le=MAX_WINDOWS), _: None = Depends(require_token)):
    actor_id, epoch = await agent_allowed(bot_id, body)
    await selected_display(bot_id, display)
    try:
        width, height = geometry()
        x, y = scale_point(float(body["x"]), float(body["y"]), width, height)
        if isinstance(body["dy"], bool) or int(body["dy"]) != body["dy"]:
            raise ValueError()
        dy = int(body["dy"])
        if not -20 <= dy <= 20 or dy == 0:
            raise ValueError()
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="invalid coordinates or scroll delta") from exc
    button = "5" if dy > 0 else "4"
    for _ in range(abs(dy)):
        result = await _fence(bot_id).run_effect("xdotool", actor_id, epoch,
            native_command(bot_id, display, ["xdotool", "mousemove", "--sync", str(x), str(y), "click", button], actor_id=actor_id, epoch=epoch))
        if isinstance(result, ActionOutcome): return {"ok": False, "code": "DESKTOP_BUSY", "status": result.value}
    return {"ok": True}


@app.post("/desktops/{bot_id}/record/start")
async def record_start(bot_id: str, body: dict, display: int = Query(1, ge=1, le=MAX_WINDOWS), _: None = Depends(require_token)):
    actor_id, epoch = await agent_allowed(bot_id, body)
    result = await _fence(bot_id).run_effect("record_start", actor_id, epoch,
        _start_recording(bot_id, body, display))
    if isinstance(result, ActionOutcome): return {"ok": False, "code": "DESKTOP_BUSY", "status": result.value}
    return result


async def _start_recording(bot_id: str, body: dict, display: int):
    desk = await selected_display(bot_id, display)
    if bot_id in recordings and recordings[bot_id][0].returncode is None:
        raise HTTPException(status_code=409, detail="recording already active")
    try:
        raw_seconds = body.get("maxSeconds", 600)
        if isinstance(raw_seconds, bool) or int(raw_seconds) != raw_seconds:
            raise ValueError()
        max_seconds = int(raw_seconds)
        if not 1 <= max_seconds <= 600:
            raise ValueError()
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=400, detail="maxSeconds must be between 1 and 600") from exc
    workspace_bot_id = str(body.get("botId") or bot_id)
    uid, root, home = workspace.prepare(workspace_bot_id)
    recordings_dir = root / "recordings"
    recordings_dir.mkdir(parents=True, exist_ok=True)
    os.chown(recordings_dir, uid, uid)
    os.chmod(recordings_dir, 0o700)
    name = safe_recording_name(body.get("name"))
    path = recordings_dir / f"{name}.webm"
    encoder = "libvpx-vp9"
    probe = await asyncio.create_subprocess_exec("ffmpeg", "-hide_banner", "-encoders", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    encoders, _ = await probe.communicate()
    if b"libvpx-vp9" not in encoders:
        encoder = "libx264"
        path = path.with_suffix(".mp4")
    if path.exists():
        path = path.with_name(f"{path.stem}-{int(time.time())}{path.suffix}")
    width, height = geometry()
    args = ffmpeg_argv(desk.display, width, height, str(path), max_seconds, encoder)
    args[1:1] = ["-progress", "pipe:1", "-nostats"]
    process = await asyncio.create_subprocess_exec(
        "setpriv", "--reuid", str(uid), "--regid", str(uid), "--clear-groups", "--inh-caps=-all", *args,
        env={"DISPLAY": f":{desk.display}", "HOME": str(home), "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"},
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    try:
        await asyncio.wait_for(_recording_ready(process), timeout=10)
    except (RuntimeError, asyncio.TimeoutError, asyncio.CancelledError) as exc:
        if process.returncode is None:
            process.kill()
        await process.wait()
        if isinstance(exc, asyncio.CancelledError):
            raise
        raise HTTPException(status_code=503, detail="recording could not start")
    # Progress is bounded by maxSeconds; drain it so a long recording cannot
    # block on a full pipe after the first-frame handshake.
    asyncio.create_task(_drain_recording_progress(process))
    recordings[bot_id] = (process, path, time.monotonic(), root)
    return {"ok": True, "name": path.name, "path": workspace.publish_under(root, path), "maxSeconds": max_seconds}


async def _recording_ready(process):
    while line := await process.stdout.readline():
        if line.startswith(b"frame=") and int(line.split(b"=", 1)[1]) > 0:
            return
    raise RuntimeError("recorder exited before producing a frame")


async def _drain_recording_progress(process):
    while await process.stdout.readline():
        pass


@app.post("/desktops/{bot_id}/record/stop")
async def record_stop(bot_id: str, body: dict, _: None = Depends(require_token)):
    await agent_allowed(bot_id, body)
    recording = recordings.pop(bot_id, None)
    if recording is None:
        raise HTTPException(status_code=404, detail="no active recording")
    process, path, started, root = recording
    if process.returncode is None:
        try:
            process.stdin.write(b"q\n")
            await process.stdin.drain()
            await asyncio.wait_for(process.wait(), timeout=20)
        except (BrokenPipeError, asyncio.TimeoutError):
            process.kill()
            await process.wait()
    size = path.stat().st_size if path.is_file() else 0
    if size == 0:
        raise HTTPException(status_code=503, detail="recording produced no video")
    return {"ok": True, "path": workspace.publish_under(root, path), "bytes": size, "seconds": round(time.monotonic() - started, 2), "name": path.name}


@app.post("/desktops/{bot_id}/type")
async def desktop_type(bot_id: str, body: dict, display: int = Query(1, ge=1, le=MAX_WINDOWS), _: None = Depends(require_token)):
    actor_id, epoch = await agent_allowed(bot_id, body)
    await selected_display(bot_id, display)
    text = body.get("text", "")
    if not isinstance(text, str) or len(text) > 10000:
        raise HTTPException(status_code=400, detail="invalid text")
    # stdin keeps typed text out of process arguments and logs.
    result = await _fence(bot_id).run_effect("xdotool", actor_id, epoch, native_command(bot_id, display, ["xdotool", "type", "--clearmodifiers", "--delay", "1", "--file", "-"], text.encode(), actor_id=actor_id, epoch=epoch))
    if isinstance(result, ActionOutcome): return {"ok": False, "code": "DESKTOP_BUSY", "status": result.value}
    return {"ok": True}


@app.get("/desktops/{bot_id}")
async def desktop_status(bot_id: str, _: None = Depends(require_token)):
    return manager.status(bot_id)


@app.post("/desktops/{bot_id}/chrome/restart")
async def restart_chrome(bot_id: str, _: None = Depends(require_token)):
    await manager.restart_chrome(bot_id)
    await _hub().reconnect(bot_id)
    return manager.status(bot_id)


@app.post("/desktops/{bot_id}/viewer")
async def set_viewer(bot_id: str, body: dict, _: None = Depends(require_token)):
    await selected_display(bot_id, int(body.get("display", 1)))
    await manager.set_viewer(bot_id, bool(body.get("up", True)), int(body.get("display", 1)))
    return manager.status(bot_id, int(body.get("display", 1)))


@app.post("/desktops/{bot_id}/control")
async def set_control(bot_id: str, body: dict, _: None = Depends(require_token)):
    display = int(body.get("display", 1))
    await selected_display(bot_id, display)
    holder = str(body.get("holder", ""))
    if holder not in {"human", "agent", "fenced"}:
        raise HTTPException(status_code=400, detail="invalid lease holder")
    epoch = int(body["epoch"])
    actor_id = str(body.get("actorId") or ("api-human" if holder == "human" else "agent:service"))
    try:
        await _fence(bot_id).set_holder(holder, actor_id if holder != "fenced" else None,
                                        str(body.get("tabId")) if holder == "human" else None, epoch)
        await manager.set_holder(bot_id, holder, epoch)
    except (StaleDesktopEpoch, LeaseConflict) as exc:
        state = exc.current if isinstance(exc, LeaseConflict) else None
        raise HTTPException(status_code=409, detail={"code": "DESKTOP_BUSY", "holder": getattr(exc, "holder", state.holder_kind if state else "unknown"), "epoch": getattr(exc, "epoch", state.epoch if state else epoch)}) from exc
    return manager.status(bot_id, display)


@app.post("/desktops/{bot_id}/lease")
async def desktop_lease(bot_id: str, body: dict, _: None = Depends(require_token)):
    if bot_id not in manager.desktops:
        raise HTTPException(status_code=404, detail="desktop not ready")
    actor_id = body.get("actorId")
    action = body.get("action")
    if not isinstance(actor_id, str) or not actor_id or len(actor_id) > 128:
        raise HTTPException(status_code=400, detail="invalid actor")
    action = str(action)
    role = str(body.get("role", "human"))
    if action == "state":
        state = await _fence(bot_id).state()
        return {"actorId": state.holder_user_id, "role": state.holder_kind, "epoch": state.epoch}
    if action not in {"acquire", "release"} or role not in {"human", "agent"}:
        raise HTTPException(status_code=400, detail="invalid lease action")
    epoch = body.get("epoch")
    if not isinstance(epoch, int) or isinstance(epoch, bool):
        raise HTTPException(status_code=400, detail="lease epoch required")
    holder = "human" if action == "acquire" else "agent"
    tab_id = body.get("tabId") if holder == "human" else None
    try:
        await _fence(bot_id).set_holder(holder, actor_id if holder == "human" else "agent:service", tab_id, epoch)
        await manager.set_holder(bot_id, holder, epoch)
    except (StaleDesktopEpoch, LeaseConflict) as exc:
        state = exc.current if isinstance(exc, LeaseConflict) else None
        raise HTTPException(status_code=409, detail={"code": "DESKTOP_BUSY", "epoch": getattr(exc, "epoch", state.epoch if state else epoch)}) from exc
    state = await _fence(bot_id).state()
    return {"actorId": state.holder_user_id, "role": state.holder_kind, "epoch": state.epoch, "expiresIn": state.ttl}


@app.post("/desktops/{bot_id}/teach/start")
async def teach_start(bot_id: str, body: dict, _: None = Depends(require_token)):
    global teach_recorder
    # Display 2 is the isolated fork window used for private demonstrations.
    if body.get("display") != 2:
        raise HTTPException(status_code=400, detail="Teach requires the private fork display")
    workspace_bot_id = body.get("workspaceBotId")
    if not isinstance(workspace_bot_id, str):
        raise HTTPException(status_code=400, detail="invalid workspace bot")
    try:
        workspace.safe_id(workspace_bot_id)
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=400, detail="invalid workspace bot") from exc
    try:
        desk = await manager.select_display(bot_id, 2)
        if teach_recorder is None:
            teach_recorder = Recorder(os.environ.get("TEACH_RECORDING_ROOT", "/data/state/teach-sessions"))
        session = teach_recorder.start(desk.display, private_window=True)
        return {"id": session["id"], "ffmpegPid": session["ffmpegPid"], "display": desk.display}
    except RecorderConflict as exc:
        raise HTTPException(status_code=409, detail="Teach is already active") from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="desktop not ready") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="private fork display unavailable") from exc


@app.post("/desktops/{bot_id}/teach/stop")
async def teach_stop(bot_id: str, body: dict, _: None = Depends(require_token)):
    if teach_recorder is None:
        raise HTTPException(status_code=404, detail="recording session not found")
    session_id = body.get("sessionId")
    if not isinstance(session_id, str) or not session_id or len(session_id) > 96:
        raise HTTPException(status_code=400, detail="invalid session")
    workspace_bot_id = body.get("workspaceBotId")
    if not isinstance(workspace_bot_id, str):
        raise HTTPException(status_code=400, detail="invalid workspace bot")
    try:
        workspace.safe_id(workspace_bot_id)
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=400, detail="invalid workspace bot") from exc
    try:
        session = teach_recorder.stop(session_id)
        video = Path(session["videoPath"])
        if not video.is_file() or video.stat().st_size > 45 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="recording unavailable or too large")
        safe_session = session["id"]
        recording_path = f"/workspace/teach-sessions/{safe_session}.mp4"
        uid = workspace.ensure(workspace_bot_id)
        target = workspace.locate_under(workspace.root_for(workspace_bot_id), recording_path)
        def attach_recording():
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(video.read_bytes())
        workspace.call_as(uid, attach_recording)
        metadata = base64.b64encode(json.dumps(session["metadata"], separators=(",", ":")).encode()).decode("ascii")
        return FileResponse(video, media_type="video/mp4", filename="demo.mp4",
                            headers={"X-Teach-Session": session["id"], "X-Teach-Metadata": metadata,
                                     "X-Teach-Path": recording_path})
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="recording session not found") from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail="recording failed") from exc


@app.post("/desktops/{bot_id}/vnc-tokens")
async def put_tokens(bot_id: str, body: dict, _: None = Depends(require_token)):
    desk = manager.desktops[bot_id]
    pairs = {}
    for item in body.get("tokens", []):
        mode = item["mode"]
        prefix = "view" if mode == "view" else "ctl"
        target_port = view_port(desk.display) if mode == "view" else rw_port(desk.display)
        pairs[f"{prefix}-{bot_id}-{item['token']}"] = f"127.0.0.1:{target_port}"
    # TokenFile keys are the raw token. Keep the raw token as the lookup key.
    raw_pairs = {}
    for item in body.get("tokens", []):
        port = view_port(desk.display) if item["mode"] == "view" else rw_port(desk.display)
        raw_pairs[item["token"]] = f"127.0.0.1:{port}"
    prefix = f"scope-{bot_id}-"
    # Drop previous tokens for this bot by rewriting from the request: the API sends the full live set.
    manager.tokens.entries = {
        token: target
        for token, target in manager.tokens.entries.items()
        if not target.endswith(f":{view_port(desk.display)}") and not target.endswith(f":{rw_port(desk.display)}")
    }
    manager.tokens.entries.update(raw_pairs)
    manager.tokens.flush()
    return {"ok": True, "count": len(raw_pairs)}


@app.post("/desktops/{bot_id}/browser/open")
async def browser_open(bot_id: str, body: dict, _: None = Depends(require_token)):
    actor_id, epoch = await agent_allowed(bot_id, body)
    result = await _fence(bot_id).run_effect("cdp", actor_id, epoch, _hub().open_tab(bot_id, body["url"], body.get("wait")))
    return result


@app.post("/desktops/{bot_id}/browser/extract")
async def browser_extract(bot_id: str, body: dict, _: None = Depends(require_token)):
    actor_id, epoch = await agent_allowed(bot_id, body, "browser_screenshot")
    result = await _fence(bot_id).run_effect("browser_screenshot", actor_id, epoch,
        _hub().extract(bot_id, body.get("targetId"), body.get("selector")))
    return {"code": "DESKTOP_BUSY", "status": result.value} if isinstance(result, ActionOutcome) else result


@app.post("/desktops/{bot_id}/browser/inspect")
async def browser_inspect(bot_id: str, body: dict, _: None = Depends(require_token)):
    actor_id, epoch = await agent_allowed(bot_id, body)
    async def inspect():
        await _hub().list_pages(bot_id)
        return await _hub().inspect(bot_id, body["targetId"], _selector(body.get("selector") or body.get("element")))
    result = await _fence(bot_id).run_effect("cdp", actor_id, epoch, inspect())
    return {"code": "DESKTOP_BUSY", "status": result.value} if isinstance(result, ActionOutcome) else result


@app.post("/desktops/{bot_id}/browser/type-secret")
async def browser_type_secret(bot_id: str, body: dict, _: None = Depends(require_token)):
    actor_id, epoch = await agent_allowed(bot_id, body)
    value = str(body.get("value") or "")
    try:
        await _hub().list_pages(bot_id)
        return await _fence(bot_id).run_effect("cdp", actor_id, epoch, _hub().type_secret(
            bot_id,
            body["targetId"],
            _selector(body.get("selector") or body.get("element")),
            value,
            str(body.get("expectedOrigin") or ""),
        ))
    finally:
        del value


@app.post("/desktops/{bot_id}/browser/fill-login")
async def browser_fill_login(bot_id: str, body: dict, _: None = Depends(require_token)):
    actor_id, epoch = await agent_allowed(bot_id, body)
    fields = body.get("fields") or []
    try:
        return await _fence(bot_id).run_effect("cdp", actor_id, epoch, _hub().fill_login(
            bot_id,
            str(body.get("targetId") or ""),
            fields if isinstance(fields, list) else [],
            str(body.get("expectedOrigin") or ""),
            str(body.get("submitSelector") or ""),
        ))
    finally:
        if isinstance(fields, list):
            for field in fields:
                if isinstance(field, dict):
                    field["value"] = ""
            fields.clear()


@app.post("/desktops/{bot_id}/browser/click")
async def browser_click(bot_id: str, body: dict, _: None = Depends(require_token)):
    actor_id, epoch = await agent_allowed(bot_id, body)
    return await _fence(bot_id).run_effect("cdp", actor_id, epoch, _hub().click(bot_id, body["targetId"], body["selector"]))


@app.post("/desktops/{bot_id}/browser/screenshot")
async def browser_screenshot(bot_id: str, body: dict, _: None = Depends(require_token)):
    actor_id, epoch = await agent_allowed(bot_id, body, "browser_screenshot")
    png = await _fence(bot_id).run_effect("browser_screenshot", actor_id, epoch, _hub().screenshot(bot_id, body.get("targetId")))
    if isinstance(png, ActionOutcome): return {"code": "DESKTOP_BUSY", "status": png.value}
    return Response(content=png, media_type="image/png")


@app.get("/desktops/{bot_id}/pages")
async def pages(bot_id: str, _: None = Depends(require_token)):
    return {"pages": await _hub().list_pages(bot_id)}


@app.post("/desktops/{bot_id}/cookies")
async def set_cookie(bot_id: str, body: dict, _: None = Depends(require_token)):
    await _hub().set_cookie(bot_id, body["name"], body["value"], body["url"])
    return {"ok": True}


@app.get("/desktops/{bot_id}/cookies")
async def get_cookies(bot_id: str, _: None = Depends(require_token)):
    return {"cookies": await _hub().cookies(bot_id)}


@app.post("/desktops/{bot_id}/shell")
async def shell(bot_id: str, body: dict, _: None = Depends(require_token)):
    actor_id, epoch = await agent_allowed(bot_id, body, "shell")
    command, timeout = _shell_request(body, 30)
    result = await _fence(bot_id).run_effect("shell", actor_id, epoch,
        run_command(bot_id, command, None, timeout, []))
    return {"code": "DESKTOP_BUSY", "status": result.value} if isinstance(result, ActionOutcome) else result


def _shell_request(body: dict, default_timeout: int) -> tuple[str, int]:
    command = body.get("command", "")
    timeout = body.get("timeout", default_timeout)
    if (not isinstance(command, str) or len(command) > 10000 or
            not isinstance(timeout, int) or isinstance(timeout, bool) or not 1 <= timeout <= 120):
        raise HTTPException(status_code=400, detail="invalid shell request")
    return command, timeout


@app.post("/desktops/{bot_id}/setup-env")
async def setup_env(bot_id: str, body: dict, _: None = Depends(require_token)):
    actor_id, epoch = await agent_allowed(bot_id, body, "shell")
    command, timeout = _shell_request(body, 30)
    raw_env = body.get("env") or {}
    if not isinstance(raw_env, dict) or len(raw_env) > 64:
        raise HTTPException(status_code=400, detail="invalid environment")
    if any(not isinstance(k, str) or not k or len(k) > 128 or not isinstance(v, str) or len(v) > 65536 for k, v in raw_env.items()):
        raise HTTPException(status_code=400, detail="invalid environment")
    env = dict(raw_env)
    values = list(env.values())
    try:
        result = await _fence(bot_id).run_effect("shell", actor_id, epoch,
            run_command(bot_id, command, env, timeout, values))
        return {"code": "DESKTOP_BUSY", "status": result.value} if isinstance(result, ActionOutcome) else result
    finally:
        try:
            scrub_tree(values, workspace.root_for(bot_id))
        except ValueError:
            pass
        env.clear()
        values.clear()


@app.post("/desktops/{bot_id}/ssh-key")
async def ssh_key(bot_id: str, body: dict, _: None = Depends(require_token)):
    actor_id, epoch = await agent_allowed(bot_id, body, "shell")
    material = str(body.get("material") or "")
    command, timeout = _shell_request(body, 20)
    if len(material) > 65536:
        raise HTTPException(status_code=400, detail="invalid key material")
    key_path = Path("/run/desk/keys") / f"{bot_id}-{int(time.time())}.key"
    key_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        key_path.write_text(material)
        os.chmod(key_path, 0o600)
        command = command or "true"
        if material and material in command:
            return {"exitCode": 126, "stdout": "", "stderr": "command contains a resolved secret", "rejected": True}
        result = await _fence(bot_id).run_effect("shell", actor_id, epoch, run_command(
            bot_id,
            command,
            {"GIT_SSH_COMMAND": f"ssh -i {key_path} -o IdentitiesOnly=yes"},
            timeout,
            [material],
        ))
        return {"code": "DESKTOP_BUSY", "status": result.value} if isinstance(result, ActionOutcome) else result
    finally:
        if key_path.exists():
            key_path.unlink()
        scrub_tree([material])


@app.post("/desktops/{bot_id}/human-input")
async def human_input(bot_id: str, body: dict, _: None = Depends(require_token)):
    desk = manager.desktops.get(bot_id)
    epoch = body.get("epoch")
    if desk is None or desk.holder != "human" or not isinstance(epoch, int) or isinstance(epoch, bool) or epoch != desk.epoch:
        raise HTTPException(status_code=403, detail="human control is not held")
    target = str(body.get("targetId") or "")
    selector = _selector(body.get("selector") or body.get("element"))
    if not target:
        pages = await _hub().list_pages(bot_id)
        if pages:
            target = await _hub().page_with_selector(bot_id, pages, selector) or str(pages[-1]["targetId"])
    return await _hub().human_click(bot_id, target, selector)


def _as_bot(bot_id: str, fn):
    try:
        uid, root, _home = workspace.prepare(bot_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="bad bot id") from exc

    def run():
        return fn(root)

    try:
        return workspace.call_as(uid, run)
    except PermissionError as exc:
        raise HTTPException(status_code=400, detail="path_escapes_workspace") from exc
    except OSError as exc:
        raise HTTPException(status_code=403, detail="workspace_denied") from exc


@app.get("/desktops/{bot_id}/files")
async def list_files(bot_id: str, path: str = "/workspace", _: None = Depends(require_token)):
    def read(root: Path):
        target = workspace.locate_under(root, path)
        shown = workspace.publish_under(root, target)
        if not target.exists():
            return {"path": shown, "entries": []}
        if target.is_file():
            return {"path": shown, "entries": [_entry(target, root)]}
        entries = [_entry(child, root) for child in sorted(target.iterdir(), key=lambda item: item.name)[:200]]
        return {"path": shown, "entries": entries}

    return _as_bot(bot_id, read)


@app.put("/desktops/{bot_id}/files")
async def put_file(bot_id: str, request: Request, _: None = Depends(require_token)):
    header_path = request.headers.get("x-path") or "/workspace/upload.bin"
    data = await request.body()
    if len(data) > 50_000_000:
        raise HTTPException(status_code=413, detail="file too large")

    def write(root: Path):
        target = workspace.locate_under(root, header_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        return {"ok": True, "path": workspace.publish_under(root, target), "size": len(data)}

    return _as_bot(bot_id, write)


@app.get("/desktops/{bot_id}/files/raw")
async def raw_file(bot_id: str, path: str, _: None = Depends(require_token)):
    def read(root: Path):
        target = workspace.locate_under(root, path)
        if not target.is_file():
            return None
        return target.read_bytes()

    body = _as_bot(bot_id, read)
    if body is None:
        raise HTTPException(status_code=404, detail="not found")
    return Response(content=body, media_type="application/octet-stream")


@app.get("/desktops/{bot_id}/recordings/raw")
async def raw_recording(bot_id: str, workspace_bot_id: str, path: str, _: None = Depends(require_token)):
    if not path.startswith("/workspace/recordings/"):
        raise HTTPException(status_code=400, detail="recording path required")
    def read(root: Path):
        target = workspace.locate_under(root, path)
        if not target.is_file() or "recordings" not in target.parts:
            return None
        return target.read_bytes()
    body = _as_bot(workspace_bot_id, read)
    if body is None:
        raise HTTPException(status_code=404, detail="not found")
    return Response(content=body, media_type="application/octet-stream")


@app.post("/desktops/{bot_id}/write-file")
async def write_file(bot_id: str, body: dict, _: None = Depends(require_token)):
    content = str(body.get("content") or "")

    def write(root: Path):
        target = workspace.locate_under(root, body["path"])
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
        return {"ok": True, "path": workspace.publish_under(root, target), "bytes": len(content.encode())}

    return _as_bot(bot_id, write)


@app.post("/desktops/{bot_id}/read-file")
async def read_file(bot_id: str, body: dict, _: None = Depends(require_token)):
    def read(root: Path):
        target = workspace.locate_under(root, body["path"])
        if not target.is_file():
            return None
        return {"path": workspace.publish_under(root, target), "content": redact(target.read_text(errors="replace")[:100_000])}

    found = _as_bot(bot_id, read)
    if found is None:
        raise HTTPException(status_code=404, detail="not found")
    return found


@app.post("/desktops/{bot_id}/edit-file")
async def edit_file(bot_id: str, body: dict, _: None = Depends(require_token)):
    search = str(body.get("search") or "")
    replace = str(body.get("replace") or "")

    def edit(root: Path):
        target = workspace.locate_under(root, body["path"])
        if not target.is_file():
            return None
        original = target.read_text()
        if search not in original:
            raise HTTPException(status_code=409, detail="search text not found")
        target.write_text(original.replace(search, replace, 1))
        return {"ok": True, "path": workspace.publish_under(root, target)}

    found = _as_bot(bot_id, edit)
    if found is None:
        raise HTTPException(status_code=404, detail="not found")
    return found


@app.post("/desktops/{bot_id}/delete-file")
async def delete_file(bot_id: str, body: dict, _: None = Depends(require_token)):
    def remove(root: Path):
        target = workspace.locate_under(root, body["path"])
        shown = workspace.publish_under(root, target)
        if not target.exists():
            return {"ok": True, "existed": False, "path": shown}
        if target.is_dir():
            raise HTTPException(status_code=400, detail="refusing to delete a directory")
        size = target.stat().st_size
        target.unlink()
        return {"ok": True, "existed": True, "bytes": size, "path": shown}

    return _as_bot(bot_id, remove)


def _selector(raw: str) -> str:
    text = (raw or "").strip()
    if not text:
        return "#password"
    if text.startswith(("#", ".", "[", "/")):
        return text
    return f"#{text}"


def _entry(path: Path, root: Path) -> dict:
    return {
        "name": path.name,
        "path": workspace.publish_under(root, path),
        "directory": path.is_dir(),
        "size": path.stat().st_size if path.is_file() else 0,
    }


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=7700, access_log=False, log_level="info")
