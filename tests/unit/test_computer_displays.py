"""Native display routing retains per-bot identity, authentication and takeover fencing."""
import asyncio
import importlib.util
import sys
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def runtime(monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / "services/computer/src"))
    # The rest of the repository can import similarly named agent modules.
    for name in ("workspace", "pure", "desktops", "browser", "fixtureserver"):
        monkeypatch.delitem(sys.modules, name, raising=False)
    from types import SimpleNamespace
    import desktops
    module = SimpleNamespace(manager=desktops.DesktopManager())
    monkeypatch.setenv("COMPUTER_TOKEN", "unit-test-only")
    monkeypatch.setenv("COMPUTER_SECOND_DISPLAY", "true")
    monkeypatch.setenv("VNC_VIEW_PORT", "5900")
    monkeypatch.setenv("VNC_RW_PORT", "6900")
    monkeypatch.setenv("CDP_PORT", "9223")
    return module


def test_secondary_is_lazy_and_keeps_bot_identity(runtime, monkeypatch):
    from desktops import Desktop
    manager = runtime.manager
    manager.desktops["bot-a"] = Desktop("bot-a", 1)
    spawn = AsyncMock()
    monkeypatch.setattr(manager, "_spawn_display", spawn)
    assert manager.list_displays("bot-a")[1]["ready"] is False
    async def run():
        desk = await manager.select_display("bot-a", 2)
        again = await manager.select_display("bot-a", 2)
        assert desk is again
        assert desk.bot_id == "bot-a" and desk.display == 2
    asyncio.run(run())
    assert spawn.await_count == 1
    assert manager.list_displays("bot-a")[1]["ready"] is True
    from desktops import view_port, rw_port, cdp_port
    assert (view_port(1), view_port(2), rw_port(2), cdp_port(2)) == (5900, 5901, 6901, 9224)
    monkeypatch.setenv("COMPUTER_SECOND_DISPLAY", "false")
    assert len(manager.list_displays("bot-a")) == 1
    with pytest.raises(ValueError):
        asyncio.run(manager.select_display("bot-a", 2))


def test_native_routes_require_auth_and_respect_human_control(runtime, monkeypatch):
    monkeypatch.setenv("DISPLAY_GEOMETRY", "1920x1200")
    pytest.importorskip("fastapi")
    pytest.importorskip("uvicorn")
    from fastapi.testclient import TestClient
    spec = importlib.util.spec_from_file_location("computer_display_server", ROOT / "services/computer/src/server.py")
    server = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(server)
    server.manager = runtime.manager
    runtime = server
    from desktops import Desktop
    runtime.manager.desktops["bot-a"] = Desktop("bot-a", 1)
    import asyncio
    from desktop_fencing import LeaseSnapshot
    asyncio.run(server._fence("bot-a").reconcile(LeaseSnapshot("agent", "agent:service", None, 1, 90)))
    select = AsyncMock(return_value=runtime.manager.desktops["bot-a"])
    command = AsyncMock(return_value=b"png")
    monkeypatch.setattr(runtime.manager, "select_display", select)
    monkeypatch.setattr(runtime.manager, "native_command", command)
    client = TestClient(runtime.app)
    auth = {"Authorization": "Bearer unit-test-only"}
    for endpoint in ("screenshot", "click", "type", "key", "scroll", "displays"):
        assert client.post(f"/desktops/bot-a/{endpoint}", json={}).status_code == 401
    stamped = {"actor_id": "agent:test", "epoch": 1}
    response = client.post("/desktops/bot-a/screenshot?display=2", headers=auth, json=stamped)
    assert response.status_code == 200 and response.content == b"png"
    assert command.call_args.args[0:2] == ("bot-a", 2)
    assert client.post("/desktops/bot-a/click", headers=auth, json={**stamped, "x": 640, "y": 400, "coordinateSpace": "model"}).status_code == 200
    assert command.call_args.args[2] == ["xdotool", "mousemove", "--sync", "960", "600", "click", "1"]
    assert client.post("/desktops/bot-a/click?display=2", headers=auth, json={**stamped, "x": 10, "y": 20}).status_code == 200
    assert command.call_args.args[2] == ["xdotool", "mousemove", "--sync", "10", "20", "click", "1"]
    assert client.post("/desktops/bot-a/type?display=2", headers=auth, json={**stamped, "text": "hello"}).status_code == 200
    assert command.call_args.args[3] == b"hello"
    assert "hello" not in command.call_args.args[2]
    assert client.post("/desktops/bot-a/key", headers=auth, json={**stamped, "keys": ["ctrl+l", "Return"]}).status_code == 200
    assert command.call_args.args[2] == ["xdotool", "key", "--clearmodifiers", "ctrl+l", "Return"]
    assert client.post("/desktops/bot-a/key", headers=auth, json={**stamped, "keys": ["$(bad)"]}).status_code == 400
    assert client.post("/desktops/bot-a/scroll", headers=auth, json={**stamped, "x": 640, "y": 400, "dy": 2}).status_code == 200
    assert command.call_args.args[2] == ["xdotool", "mousemove", "--sync", "960", "600", "click", "5"]
    assert client.post("/desktops/bot-a/click", headers=auth, json={**stamped, "x": -1, "y": 2}).status_code == 400
    assert client.post("/desktops/bot-a/screenshot?display=9", headers=auth).status_code == 422
    assert client.post("/desktops/other/screenshot", headers=auth, json=stamped).status_code == 404
    runtime.manager.desktops["bot-a"].holder = "human"
    runtime.manager.desktops["bot-a"].epoch = 2
    runtime._fence("bot-a")._release_held_callback = None
    asyncio.run(runtime._fence("bot-a").reconcile(LeaseSnapshot("human", "api-human", "tab-a", 2, 35)))
    before = command.await_count
    for endpoint in ("screenshot", "click", "type", "key", "scroll", "record/start", "record/stop"):
        response = client.post(f"/desktops/bot-a/{endpoint}?display=2", headers=auth, json=stamped)
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "DESKTOP_BUSY"
    assert command.await_count == before
    assert client.post("/desktops/bot-a/shell", headers=auth, json={**stamped, "command": "true"}).status_code == 409
    import types
    server.hub = types.SimpleNamespace(open_tab=AsyncMock())
    assert client.post("/desktops/bot-a/browser/open", headers=auth, json={**stamped, "url": "https://example.test"}).status_code == 409
    server.hub.open_tab.assert_not_awaited()


def test_shell_runner_terminates_process_group_after_bounded_drain(monkeypatch):
    import signal
    monkeypatch.syspath_prepend(str(ROOT / "services/computer/src"))
    spec = importlib.util.spec_from_file_location("browser_cancel_test", ROOT / "services/computer/src/browser.py")
    browser = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(browser)

    class FakeProcess:
        pid = 98765
        returncode = None
        def __init__(self): self.wait_count = 0
        async def wait(self):
            self.wait_count += 1
            if self.wait_count == 1: raise asyncio.TimeoutError()
            return -signal.SIGKILL

    fake = FakeProcess()
    kills = []
    monkeypatch.setattr(browser.os, "killpg", lambda pid, sig: kills.append((pid, sig)))
    asyncio.run(browser.terminate_process_group(fake))
    assert kills == [(fake.pid, signal.SIGTERM), (fake.pid, signal.SIGKILL)]
    assert fake.wait_count == 2
    source = (ROOT / "services/computer/src/browser.py").read_text()
    assert "start_new_session=True" in source
    assert "await asyncio.wait_for(proc.wait(), grace_seconds)" in source


def test_teach_routes_are_authenticated_and_only_use_the_fork_display(runtime, monkeypatch, tmp_path):
    pytest.importorskip("fastapi")
    pytest.importorskip("uvicorn")
    from fastapi.testclient import TestClient
    (tmp_path / "demo.mp4").write_bytes(b"fake-mp4")
    spec = importlib.util.spec_from_file_location("computer_teach_server", ROOT / "services/computer/src/server.py")
    server = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(server)
    server.manager = runtime.manager
    bot_id = "abcdefab-cdef-abcd-efab-cdefabcdefab"
    (tmp_path / "bot").mkdir()
    monkeypatch.setattr(server.workspace, "ensure", lambda _: 1234)
    monkeypatch.setattr(server.workspace, "root_for", lambda _: tmp_path / "bot")
    monkeypatch.setattr(server.workspace, "locate_under", lambda root, path: root / path.removeprefix("/workspace/"))
    monkeypatch.setattr(server.workspace, "call_as", lambda _uid, call: call())
    class FakeRecorder:
        def start(self, display, *, private_window):
            assert display == 2 and private_window
            return {"id": "teach-test", "ffmpegPid": 44}
        def stop(self, session_id=None):
            return {"id": "teach-test", "videoPath": str(tmp_path / "demo.mp4"), "metadata": {"status": "finished"}}
    server.teach_recorder = FakeRecorder()
    from desktops import Desktop
    runtime.manager.desktops[bot_id] = Desktop(bot_id, 1)
    selected = []
    async def select(bot, display):
        selected.append((bot, display))
        assert display == 2
        return Desktop(bot, 2)
    monkeypatch.setattr(runtime.manager, "select_display", select)
    client = TestClient(server.app)
    auth = {"Authorization": "Bearer unit-test-only"}
    assert client.post(f"/desktops/{bot_id}/teach/start", json={"display": 2}).status_code == 401
    response = client.post(f"/desktops/{bot_id}/teach/start", headers=auth, json={"display": 1})
    assert response.status_code == 400
    response = client.post(f"/desktops/{bot_id}/teach/start", headers=auth, json={"display": 2, "workspaceBotId": bot_id})
    assert response.status_code == 200
    assert selected == [(bot_id, 2)]
    stopped = client.post(f"/desktops/{bot_id}/teach/stop", headers=auth, json={"sessionId": "teach-test", "workspaceBotId": bot_id})
    assert stopped.status_code == 200 and stopped.content == b"fake-mp4"
    assert (tmp_path / "bot" / "teach-sessions" / "teach-test.mp4").read_bytes() == b"fake-mp4"


def test_holder_changes_cover_both_displays(runtime, monkeypatch):
    from desktops import Desktop
    primary = Desktop("bot-a", 1)
    secondary = Desktop("bot-a", 2)
    runtime.manager.desktops["bot-a"] = primary
    runtime.manager.secondary["bot-a"] = secondary
    calls = AsyncMock()
    monkeypatch.setattr(runtime.manager, "_set_display_holder", calls)
    asyncio.run(runtime.manager.set_holder("bot-a", "agent", 5))
    assert [c.args for c in calls.call_args_list] == [(primary, "agent", 5), (secondary, "agent", 5)]


def test_holder_rejects_stale_epoch_but_allows_same_holder_retry(runtime, monkeypatch):
    from desktops import Desktop, StaleDesktopEpoch
    primary = Desktop("bot-a", 1, holder="human", epoch=6)
    runtime.manager.desktops["bot-a"] = primary
    with pytest.raises(StaleDesktopEpoch) as error:
        asyncio.run(runtime.manager.set_holder("bot-a", "agent", 5))
    assert (error.value.holder, error.value.epoch) == ("human", 6)
    calls = AsyncMock()
    monkeypatch.setattr(runtime.manager, "_set_display_holder", calls)
    asyncio.run(runtime.manager.set_holder("bot-a", "human", 6))
    assert calls.await_count == 1


def test_generated_secondary_services_use_same_uid_and_no_port_collision(runtime, monkeypatch, tmp_path):
    import desktops
    monkeypatch.setattr(desktops.workspace, "prepare", lambda bot: (31000, tmp_path / "bot", tmp_path / "home"))
    scripts = {}
    monkeypatch.setattr(desktops, "_write_service", lambda name, script, **kwargs: scripts.update({name: script}))
    monkeypatch.setattr(desktops, "_rescan", AsyncMock())
    monkeypatch.setattr(desktops, "_wait_x", AsyncMock())
    monkeypatch.setattr(desktops.asyncio, "sleep", AsyncMock())
    bot = "a" * 32
    asyncio.run(runtime.manager._spawn_display(desktops.Desktop(bot, 2)))
    assert "Xvfb :2" in scripts["xvfb-2"]
    assert "-nolisten tcp" in scripts["xvfb-2"]
    assert "--reuid 31000 --regid 31000 --clear-groups" in scripts["wm-2"]
    assert "-rfbport 5901" in scripts["vncview-2"]
    assert "-rfbport 6901" in scripts["vncrw-2"]
    assert "-viewonly" in scripts["vncview-2"]


def test_concurrent_bots_cannot_allocate_the_same_x_display(runtime, monkeypatch):
    from desktops import Desktop
    runtime.manager.desktops.update({"bot-a": Desktop("bot-a", 1), "bot-b": Desktop("bot-b", 3)})
    async def spawn(desk):
        await asyncio.sleep(0)
    monkeypatch.setattr(runtime.manager, "_spawn_display", spawn)
    async def run():
        a, b = await asyncio.gather(runtime.manager.select_display("bot-a", 2), runtime.manager.select_display("bot-b", 2))
        assert a.display != b.display
        assert a.bot_id == "bot-a" and b.bot_id == "bot-b"
    asyncio.run(run())


def test_native_command_rechecks_control_after_display_start(runtime, monkeypatch):
    from desktops import Desktop
    primary = Desktop("bot-a", 1)
    runtime.manager.desktops["bot-a"] = primary
    async def spawn(desk):
        primary.holder = "human"
    monkeypatch.setattr(runtime.manager, "_spawn_display", spawn)
    with pytest.raises(PermissionError):
        asyncio.run(runtime.manager.native_command("bot-a", 2, ["xdotool", "type", "blocked"]))
    assert runtime.manager.secondary["bot-a"].holder == "human"


def test_secondary_status_returns_allocated_ports(runtime, monkeypatch):
    import desktops
    runtime.manager.desktops["bot-a"] = desktops.Desktop("bot-a", 1)
    runtime.manager.secondary["bot-a"] = desktops.Desktop("bot-a", 4)
    monkeypatch.setattr(desktops, "_port_open", lambda port: False)
    assert runtime.manager.status("bot-a", 2)["viewPort"] == 5903
    assert runtime.manager.status("bot-a", 2)["rwPort"] == 6903


def test_native_process_uses_bot_uid_without_inheriting_service_credentials(runtime, monkeypatch, tmp_path):
    import desktops
    runtime.manager.desktops["bot-a"] = desktops.Desktop("bot-a", 1)
    monkeypatch.setattr(desktops.workspace, "prepare", lambda bot: (31000, tmp_path, tmp_path / "home"))
    called = {}
    class Process:
        returncode = 0
        async def communicate(self, data):
            called["stdin"] = data
            return b"ok", b""
    async def create(*argv, **kwargs):
        called.update(argv=argv, **kwargs)
        return Process()
    monkeypatch.setattr(desktops.asyncio, "create_subprocess_exec", create)
    monkeypatch.setenv("COMPUTER_TOKEN", "unit-test-only")
    output = asyncio.run(runtime.manager.native_command("bot-a", 1, ["xdotool", "type", "--file", "-"], b"hello"))
    assert output == b"ok"
    assert called["argv"][:6] == ("setpriv", "--reuid", "31000", "--regid", "31000", "--clear-groups")
    assert called["env"]["DISPLAY"] == ":1"
    assert "COMPUTER_TOKEN" not in called["env"]
    assert called["stdin"] == b"hello"


def test_windows_allocate_distinct_contract_ports_and_destroy_independently(runtime, monkeypatch, tmp_path):
    monkeypatch.setattr("desktops.STATE_PATH", tmp_path / "state.json")
    from desktops import Desktop
    manager = runtime.manager
    manager.desktops["bot-a"] = Desktop("bot-a", 1)
    monkeypatch.setattr(manager, "_spawn_display", AsyncMock())
    monkeypatch.setattr("desktops._rescan", AsyncMock())
    async def run():
        a, b, c = await asyncio.gather(*(manager.select_display("bot-a", n) for n in (2, 3, 4)))
        assert len({a.display, b.display, c.display}) == 3
        await manager.destroy("bot-a", 3)
        assert manager.status("bot-a", 3) == {"ready": False}
        assert manager.status("bot-a", 2)["ready"] is True
        assert manager.status("bot-a", 4)["ready"] is True
    asyncio.run(run())


def test_window_limit_rejects_ninth_and_validates_display(runtime):
    from desktops import Desktop
    manager = runtime.manager
    manager.desktops["bot-a"] = Desktop("bot-a", 1)
    for window in range(2, 9):
        manager.windows[("bot-a", window)] = Desktop("bot-a", window)
    with pytest.raises(ValueError):
        asyncio.run(manager.select_display("bot-a", 9))


def test_takeover_stops_native_recording(runtime, monkeypatch, tmp_path):
    from desktop_fencing import LeaseSnapshot
    spec = importlib.util.spec_from_file_location("computer_recording_fence", ROOT / "services/computer/src/server.py")
    server = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(server)
    server.manager = runtime.manager
    process = type("RecordingProcess", (), {})()
    process.returncode = None
    process.kill = lambda: setattr(process, "returncode", -9)
    process.wait = AsyncMock(return_value=-9)
    fence = server._fence("bot-a")
    asyncio.run(fence.reconcile(LeaseSnapshot("agent", "agent:test", None, 1, 90)))
    server.recordings["bot-a"] = (process, tmp_path / "demo.webm", 0, tmp_path)
    asyncio.run(fence.reconcile(LeaseSnapshot("human", "owner", "tab", 2, 35)))
    assert process.returncode == -9
    process.wait.assert_awaited_once()
