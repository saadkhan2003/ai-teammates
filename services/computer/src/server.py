"""Computer manager: desktops, browser, files, and a view-only/control VNC token map."""
from __future__ import annotations

import json
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException, Request, Query
from fastapi.responses import Response
import workspace
from browser import BrowserHub, run_command
from desktops import DesktopManager, cdp_port, rw_port, view_port
from fixtureserver import start as start_fixtures
from pure import redact, scrub_tree

manager = DesktopManager()
hub: BrowserHub | None = None


def require_token(authorization: str = Header(default="")) -> None:
    expected = os.environ.get("COMPUTER_TOKEN", "")
    presented = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
    if not expected or not presented or not _eq(presented, expected):
        raise HTTPException(status_code=401, detail="unauthorized")


def _eq(left: str, right: str) -> bool:
    import hmac
    return hmac.compare_digest(left, right)


def agent_allowed(bot_id: str) -> None:
    desk = manager.desktops.get(bot_id)
    if desk is None:
        raise HTTPException(status_code=404, detail="desktop not ready")
    if desk.holder != "agent":
        raise HTTPException(status_code=423, detail="human holds control")


@asynccontextmanager
async def lifespan(app: FastAPI):
    global hub
    start_fixtures()
    hub = BrowserHub(manager)
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
    await hub.close()


app = FastAPI(lifespan=lifespan)


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


async def selected_display(bot_id: str, display: int):
    try:
        return await manager.select_display(bot_id, display)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="desktop not ready") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


async def native_command(bot_id: str, display: int, argv: list[str], data: bytes | None = None):
    try:
        return await manager.native_command(bot_id, display, argv, data)
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
async def desktop_screenshot(bot_id: str, display: int = Query(1, ge=1, le=2), _: None = Depends(require_token)):
    agent_allowed(bot_id)
    await selected_display(bot_id, display)
    png = await native_command(bot_id, display, ["import", "-window", "root", "png:-"])
    return Response(content=png, media_type="image/png")


@app.post("/desktops/{bot_id}/click")
async def desktop_click(bot_id: str, body: dict, display: int = Query(1, ge=1, le=2), _: None = Depends(require_token)):
    agent_allowed(bot_id)
    await selected_display(bot_id, display)
    from desktops import geometry
    width, height = geometry()
    try:
        x, y, button = int(body["x"]), int(body["y"]), int(body.get("button", 1))
        if not (0 <= x < width and 0 <= y < height and button in (1, 2, 3)):
            raise ValueError()
    except (KeyError, ValueError, TypeError) as exc:
        raise HTTPException(status_code=400, detail="invalid coordinates or button") from exc
    await native_command(bot_id, display, ["xdotool", "mousemove", "--sync", str(x), str(y), "click", str(button)])
    return {"ok": True}


@app.post("/desktops/{bot_id}/type")
async def desktop_type(bot_id: str, body: dict, display: int = Query(1, ge=1, le=2), _: None = Depends(require_token)):
    agent_allowed(bot_id)
    await selected_display(bot_id, display)
    text = body.get("text", "")
    if not isinstance(text, str) or len(text) > 10000:
        raise HTTPException(status_code=400, detail="invalid text")
    # stdin keeps typed text out of process arguments and logs.
    await native_command(bot_id, display, ["xdotool", "type", "--clearmodifiers", "--delay", "1", "--file", "-"], text.encode())
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
    await selected_display(bot_id, int(body.get("display", 1)))
    await manager.set_holder(bot_id, str(body["holder"]), int(body["epoch"]))
    return manager.status(bot_id, int(body.get("display", 1)))


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
    agent_allowed(bot_id)
    result = await _hub().open_tab(bot_id, body["url"], body.get("wait"))
    return result


@app.post("/desktops/{bot_id}/browser/extract")
async def browser_extract(bot_id: str, body: dict, _: None = Depends(require_token)):
    agent_allowed(bot_id)
    return await _hub().extract(bot_id, body.get("targetId"), body.get("selector"))


@app.post("/desktops/{bot_id}/browser/inspect")
async def browser_inspect(bot_id: str, body: dict, _: None = Depends(require_token)):
    agent_allowed(bot_id)
    await _hub().list_pages(bot_id)
    return await _hub().inspect(bot_id, body["targetId"], _selector(body.get("selector") or body.get("element")))


@app.post("/desktops/{bot_id}/browser/type-secret")
async def browser_type_secret(bot_id: str, body: dict, _: None = Depends(require_token)):
    agent_allowed(bot_id)
    value = str(body.get("value") or "")
    try:
        await _hub().list_pages(bot_id)
        return await _hub().type_secret(
            bot_id,
            body["targetId"],
            _selector(body.get("selector") or body.get("element")),
            value,
            str(body.get("expectedOrigin") or ""),
        )
    finally:
        del value


@app.post("/desktops/{bot_id}/browser/fill-login")
async def browser_fill_login(bot_id: str, body: dict, _: None = Depends(require_token)):
    agent_allowed(bot_id)
    fields = body.get("fields") or []
    try:
        return await _hub().fill_login(
            bot_id,
            str(body.get("targetId") or ""),
            fields if isinstance(fields, list) else [],
            str(body.get("expectedOrigin") or ""),
            str(body.get("submitSelector") or ""),
        )
    finally:
        if isinstance(fields, list):
            for field in fields:
                if isinstance(field, dict):
                    field["value"] = ""
            fields.clear()


@app.post("/desktops/{bot_id}/browser/click")
async def browser_click(bot_id: str, body: dict, _: None = Depends(require_token)):
    agent_allowed(bot_id)
    return await _hub().click(bot_id, body["targetId"], body["selector"])


@app.post("/desktops/{bot_id}/browser/screenshot")
async def browser_screenshot(bot_id: str, body: dict, _: None = Depends(require_token)):
    agent_allowed(bot_id)
    png = await _hub().screenshot(bot_id, body.get("targetId"))
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
    result = await run_command(bot_id, str(body.get("command") or ""), None, int(body.get("timeout") or 30), [])
    return result


@app.post("/desktops/{bot_id}/setup-env")
async def setup_env(bot_id: str, body: dict, _: None = Depends(require_token)):
    env = {str(k): str(v) for k, v in (body.get("env") or {}).items()}
    values = list(env.values())
    try:
        return await run_command(bot_id, str(body.get("command") or ""), env, int(body.get("timeout") or 30), values)
    finally:
        try:
            scrub_tree(values, workspace.root_for(bot_id))
        except ValueError:
            pass
        env.clear()
        values.clear()


@app.post("/desktops/{bot_id}/ssh-key")
async def ssh_key(bot_id: str, body: dict, _: None = Depends(require_token)):
    material = str(body.get("material") or "")
    key_path = Path("/run/desk/keys") / f"{bot_id}-{int(time.time())}.key"
    key_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        key_path.write_text(material)
        os.chmod(key_path, 0o600)
        command = str(body.get("command") or "true")
        if material and material in command:
            return {"exitCode": 126, "stdout": "", "stderr": "command contains a resolved secret", "rejected": True}
        result = await run_command(
            bot_id,
            command,
            {"GIT_SSH_COMMAND": f"ssh -i {key_path} -o IdentitiesOnly=yes"},
            int(body.get("timeout") or 20),
            [material],
        )
        return result
    finally:
        if key_path.exists():
            key_path.unlink()
        scrub_tree([material])


@app.post("/desktops/{bot_id}/human-input")
async def human_input(bot_id: str, body: dict, _: None = Depends(require_token)):
    desk = manager.desktops.get(bot_id)
    if desk is None or desk.holder != "human":
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
