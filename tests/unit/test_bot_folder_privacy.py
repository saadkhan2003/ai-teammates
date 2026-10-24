"""The shared per-owner desktop must keep each bot's files in that bot's own folder
and must never write into the folder of a deleted bot."""
import asyncio
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
DESK = "d" * 32  # the owner's desktop bot (later deleted)
ALICE = "a" * 32
BOB = "b" * 32


@pytest.fixture
def ws(tmp_path, monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / "services/computer/src"))
    for name in ("workspace", "pure", "desktops", "browser", "fixtureserver"):
        monkeypatch.delitem(sys.modules, name, raising=False)
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path / "ws"))
    monkeypatch.setenv("STATE_ROOT", str(tmp_path / "state"))
    monkeypatch.setenv("HOME_ROOT", str(tmp_path / "home"))
    import workspace
    return workspace


def test_deleted_bot_folder_is_never_recreated(ws):
    uid = ws.ensure(DESK)
    (ws.root_for(DESK) / "notes.txt").write_text("private")
    ws.wipe(DESK)
    assert not ws.root_for(DESK).exists() and not ws.home_for(DESK).exists()
    assert ws.is_deleted(DESK)
    for call in (ws.ensure, ws.prepare):
        with pytest.raises(ws.WorkspaceDeleted):
            call(DESK)
    assert not ws.root_for(DESK).exists() and not ws.home_for(DESK).exists()
    # The uid stays reserved so a still-running process of the deleted bot can
    # never reach a new bot that would otherwise reuse it.
    mapping = json.loads((Path(os.environ["STATE_ROOT"]) / "bot-uids.json").read_text())
    assert mapping["retired:" + DESK] == uid and DESK not in mapping
    assert ws.ensure(ALICE) != uid


def test_shared_desktop_of_deleted_bot_runs_in_scratch_folder(ws):
    live = ws.desktop_identity(ALICE)
    assert live[1] == ws.root_for(ALICE)
    ws.ensure(DESK)
    ws.wipe(DESK)
    uid, root, home = ws.desktop_identity(DESK)
    assert root != ws.root_for(DESK) and home != ws.home_for(DESK)
    assert root.is_dir() and root.name == ws.desktop_scratch_id(DESK)
    assert root.name not in (ALICE, BOB, DESK)
    assert not ws.root_for(DESK).exists()


def test_desktop_services_never_point_at_deleted_folder(ws, monkeypatch):
    import desktops
    written = {}
    monkeypatch.setattr(desktops, "_write_service", lambda name, body, down=False: written.__setitem__(name, body))
    async def nothing(*_args, **_kwargs):
        return None
    for name in ("_rescan", "_wait_x"):
        monkeypatch.setattr(desktops, name, nothing)
    monkeypatch.setattr(desktops.asyncio, "sleep", nothing)
    ws.ensure(DESK)
    ws.wipe(DESK)
    asyncio.run(desktops.DesktopManager()._spawn_display(desktops.Desktop(DESK, 1)))
    for name in ("wm-1", "panels-1"):
        assert str(ws.root_for(DESK)) not in written[name]
        assert str(ws.home_for(DESK)) not in written[name]
        assert f"export BOT_ROOT={ws.root_for(ws.desktop_scratch_id(DESK))}" in written[name]
    assert not ws.root_for(DESK).exists()


@pytest.fixture
def server(ws, monkeypatch):
    pytest.importorskip("fastapi")
    pytest.importorskip("uvicorn")
    from types import SimpleNamespace
    import desktops
    from desktops import Desktop
    from desktop_fencing import LeaseSnapshot
    monkeypatch.setenv("COMPUTER_TOKEN", "unit-test-only")
    spec = importlib.util.spec_from_file_location("computer_privacy_server", ROOT / "services/computer/src/server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.manager = desktops.DesktopManager()
    module.manager.desktops[DESK] = Desktop(DESK, 1)
    asyncio.run(module._fence(DESK).reconcile(LeaseSnapshot("agent", "agent:service", None, 1, 90)))
    return module


def _shell(server, body):
    from fastapi.testclient import TestClient
    client = TestClient(server.app)
    return client.post(f"/desktops/{DESK}/shell", headers={"Authorization": "Bearer unit-test-only"},
                       json={"actor_id": "agent:test", "epoch": 1, **body})


def test_shared_desktop_shell_writes_only_into_the_calling_bots_folder(server, ws):
    ws.ensure(DESK)
    for bot in (ALICE, BOB):
        result = _shell(server, {"command": f"echo {bot} > /workspace/mine.txt; pwd", "workspace_bot_id": bot})
        assert result.status_code == 200 and result.json()["exitCode"] == 0, result.text
        assert result.json()["stdout"].strip() == str(ws.root_for(bot))
        assert (ws.root_for(bot) / "mine.txt").read_text().strip() == bot
    assert not (ws.root_for(DESK) / "mine.txt").exists()
    assert _shell(server, {"command": "true", "workspace_bot_id": "../" + ALICE}).status_code == 400


def test_shared_desktop_shell_never_writes_into_deleted_bot_folder(server, ws):
    ws.ensure(DESK)
    ws.ensure(BOB)
    ws.wipe(DESK)
    ws.wipe(BOB)
    for body in ({"command": "touch /workspace/leak.txt"},
                 {"command": "touch /workspace/leak.txt", "workspace_bot_id": BOB}):
        result = _shell(server, body)
        assert result.status_code == 200
        assert result.json()["rejected"] is True and result.json()["stderr"] == "workspace_deleted"
    assert not ws.root_for(DESK).exists() and not ws.root_for(BOB).exists()
    from fastapi.testclient import TestClient
    files = TestClient(server.app).get(f"/desktops/{BOB}/files", headers={"Authorization": "Bearer unit-test-only"})
    assert files.status_code == 410
    assert not ws.root_for(BOB).exists()


def test_api_sends_the_calling_bot_as_shell_workspace():
    runtime = (ROOT / "apps/api/Runtime.cs").read_text()
    shell = runtime.split('$"/desktops/{placement.Desktop}/shell"', 1)[1].split(";", 1)[0]
    setup = runtime.split('$"/desktops/{desktop}/setup-env"', 1)[1].split(";", 1)[0]
    for call in (shell, setup):
        assert 'workspace_bot_id = botId.ToString("N")' in call
    source = (ROOT / "services/computer/src/server.py").read_text()
    for route in ("shell", "setup-env", "ssh-key"):
        section = source.split(f'@app.post("/desktops/{{bot_id}}/{route}")', 1)[1].split("@app.", 1)[0]
        assert "_workspace_bot(bot_id, body)" in section and "run_command(bot_id" not in section


@pytest.mark.parametrize("script,binary", [("launch-terminal", "xfce4-terminal"), ("launch-files", "thunar")])
def test_desktop_launchers_open_only_this_displays_bot_folder(tmp_path, script, binary):
    services = tmp_path / "service"
    alice = tmp_path / "bots" / ALICE
    alice.mkdir(parents=True)
    gone = tmp_path / "bots" / DESK  # deleted: its folder no longer exists
    for display, root in ((1, alice), (2, gone)):
        (services / f"wm-{display}").mkdir(parents=True)
        (services / f"wm-{display}" / "run").write_text(
            f"#!/bin/sh\nexport DISPLAY=:{display}\nexport HOME={root}\nexport BOT_ROOT={root}\n")
    stubs = tmp_path / "bin"
    stubs.mkdir()
    log = tmp_path / "launched"
    (stubs / binary).write_text(f'#!/bin/sh\npwd > "{log}"\n')
    (stubs / binary).chmod(0o755)
    path = ROOT / "services/computer/desktop" / script
    env = {"PATH": f"{stubs}:/usr/bin:/bin", "DESK_SERVICE_DIR": str(services)}
    # A deleted bot's display must not fall back to another bot's folder.
    denied = subprocess.run(["sh", str(path)], env={**env, "DISPLAY": ":2"}, cwd=tmp_path, capture_output=True, text=True)
    assert denied.returncode == 1 and not log.exists() and not gone.exists()
    opened = subprocess.run(["sh", str(path)], env={**env, "DISPLAY": ":1"}, cwd=tmp_path, capture_output=True, text=True)
    assert opened.returncode == 0, opened.stderr
    assert log.read_text().strip() == str(alice)
