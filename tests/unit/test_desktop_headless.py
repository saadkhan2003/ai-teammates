"""Headless-by-default computers: the desktop and Chrome start only for desktop or browser work,
Watch or Take control, and stop again when idle; jobs, shell and files never start them."""
import asyncio
import importlib.util
import sys
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def desktops(monkeypatch, tmp_path):
    monkeypatch.syspath_prepend(str(ROOT / "services/computer/src"))
    for name in ("workspace", "pure", "desktops", "browser", "fixtureserver", "cdp_proxy"):
        monkeypatch.delitem(sys.modules, name, raising=False)
    monkeypatch.setenv("COMPUTER_TOKEN", "unit-test-only")
    monkeypatch.setenv("CDP_ACTIVITY_DIR", str(tmp_path))
    import desktops as module
    monkeypatch.setattr(module, "CDP_ACTIVITY_DIR", tmp_path)
    manager = module.DesktopManager()
    monkeypatch.setattr(manager, "_spawn_display", AsyncMock())
    monkeypatch.setattr(manager, "_spawn_chrome", AsyncMock())
    monkeypatch.setattr(manager, "_prepare_workspace", lambda bot: None)
    monkeypatch.setattr(manager, "save", lambda: None)
    monkeypatch.setattr(module, "_svc", AsyncMock())
    monkeypatch.setattr(module, "_wait_x", AsyncMock())
    return module, manager


def test_lazy_default_and_idle_seconds(desktops, monkeypatch):
    module, _ = desktops
    monkeypatch.delenv("DESKTOP_LAZY", raising=False)
    assert module.lazy_default() is True
    monkeypatch.setenv("DESKTOP_LAZY", "false")
    assert module.lazy_default() is False
    monkeypatch.setenv("DESKTOP_IDLE_SECONDS", "5")
    assert module.idle_seconds() == 30
    monkeypatch.delenv("DESKTOP_IDLE_SECONDS")
    assert module.idle_seconds() == 300


def test_lazy_ensure_starts_nothing_and_wake_starts_desktop_then_chrome(desktops):
    module, manager = desktops
    desk = asyncio.run(manager.ensure("bot-a", 1, "Ada", True, lazy=True))
    assert desk.awake is False and desk.chrome is False
    manager._spawn_display.assert_not_awaited()
    manager._spawn_chrome.assert_not_awaited()
    status = manager.status("bot-a")
    assert status["desktop"] == "asleep" and status["chrome"] is False
    assert asyncio.run(manager.wake("bot-a")) is True
    assert manager._spawn_display.await_count == 1 and manager._spawn_chrome.await_count == 1
    assert manager.status("bot-a")["desktop"] == "on"
    assert asyncio.run(manager.wake("bot-a")) is False
    assert manager._spawn_display.await_count == 1


def test_idle_timer_stops_chrome_then_desktop_and_respects_activity(desktops, monkeypatch):
    module, manager = desktops
    asyncio.run(manager.ensure("bot-a", 1, "Ada", True, lazy=True))
    asyncio.run(manager.wake("bot-a"))
    desk = manager.desktops["bot-a"]
    now = desk.last_use
    assert manager.idle_desktops(now + 100, 300) == []
    assert manager.idle_desktops(now + 301, 300) == ["bot-a"]
    # Recent CDP traffic from a browser tool counts as use.
    activity = Path(module.CDP_ACTIVITY_DIR) / "cdp-1"
    activity.write_text("")
    import os
    os.utime(activity, (now + 250, now + 250))
    assert manager.idle_desktops(now + 301, 300) == []
    # Somebody watching keeps it awake.
    monkeypatch.setattr(module, "_has_client", lambda port: True)
    assert manager.idle_desktops(now + 1000, 300) == []
    monkeypatch.setattr(module, "_has_client", lambda port: False)
    # A human holding control is never idle-stopped.
    desk.holder = "human"
    assert manager.idle_desktops(now + 5000, 300) == []
    desk.holder = "agent"
    order = []
    async def svc(*args):
        order.append(args)
    monkeypatch.setattr(module, "_svc", svc)
    monkeypatch.setattr(module.Path, "exists", lambda self: str(self).startswith("/run/service/"))
    monkeypatch.setattr(module.Path, "write_text", lambda self, text: None)
    assert asyncio.run(manager.sleep_desktop("bot-a")) is True
    stops = [a[1].rsplit("/", 1)[1] for a in order if a[0] == "-d"]
    assert stops[0] == "chrome-1" and stops[-1] == "xvfb-1"
    assert manager.status("bot-a")["desktop"] == "asleep"
    assert manager.idle_desktops(now + 9000, 300) == []


def test_has_client_ignores_listening_sockets(desktops, monkeypatch, tmp_path):
    module, _ = desktops
    table = tmp_path / "tcp"
    table.write_text("  sl  local_address rem_address   st\n"
                     "   0: 00000000:170C 00000000:0000 0A 0\n"
                     "   1: 0100007F:1AF4 0100007F:9C40 01 0\n")
    real_open = open
    monkeypatch.setattr("builtins.open", lambda path, *a, **k: real_open(table if str(path).startswith("/proc/net/tcp") else path, *a, **k))
    assert module._has_client(0x170C) is False
    assert module._has_client(0x1AF4) is True


def _server(desktops, monkeypatch):
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient
    module, manager = desktops
    spec = importlib.util.spec_from_file_location("computer_headless_server", ROOT / "services/computer/src/server.py")
    server = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(server)
    server.manager = manager
    connect = AsyncMock()
    import types
    server.hub = types.SimpleNamespace(connect=connect, browsers={})
    monkeypatch.setattr(server, "_hub", lambda: server.hub)
    asyncio.run(manager.ensure("bot-a", 1, "Ada", True, lazy=True))
    return server, manager, TestClient(server.app), connect


def test_headless_routes_never_wake_and_desktop_routes_do(desktops, monkeypatch):
    server, manager, client, connect = _server(desktops, monkeypatch)
    auth = {"Authorization": "Bearer unit-test-only"}
    # Unauthenticated desktop calls do not wake anything.
    client.post("/desktops/bot-a/screenshot", json={})
    assert manager.is_awake("bot-a") is False
    for path in ("/desktops/bot-a/shell", "/desktops/bot-a/files", "/desktops/bot-a/read-file", "/desktops/bot-a/displays", "/metrics", "/health"):
        client.post(path, headers=auth, json={"command": "true", "path": "x"})
        client.get(path, headers=auth)
        assert manager.is_awake("bot-a") is False, path
    metrics = client.get("/metrics", headers=auth).json()
    assert metrics["desktop"] == "asleep" and metrics["desktopsOn"] == 0 and "desktopRssBytes" in metrics
    health = client.get("/health").json()
    assert health["desktop"] == "asleep" and health["x"] is True and health["chrome"] is True
    response = client.post("/desktops/bot-a/wake", headers=auth, json={})
    assert response.status_code == 200 and response.json()["desktop"] == "on"
    connect.assert_awaited_with("bot-a")
    assert client.post("/desktops/bot-a/sleep", headers=auth, json={}).json()["desktop"] == "asleep"
    assert client.post("/displays/1/wake", headers=auth, json={}).json()["desktop"] == "on"
    assert client.post("/displays/7/wake", headers=auth, json={}).status_code == 404


def test_cdp_proxy_wakes_desktop_when_chrome_is_down(desktops, monkeypatch, tmp_path):
    monkeypatch.syspath_prepend(str(ROOT / "services/computer/src"))
    import cdp_proxy
    monkeypatch.setattr(cdp_proxy, "ACTIVITY_DIR", str(tmp_path))
    calls = []
    class Response:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self, *a): return b"{}"
    def urlopen(request, timeout=0):
        calls.append((request.full_url, request.get_header("Authorization")))
        return Response()
    monkeypatch.setattr(cdp_proxy.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(cdp_proxy.json, "load", lambda r: {})
    monkeypatch.setattr(cdp_proxy, "_port_open", lambda port: False)
    cdp_proxy._ensure_chrome(1, 9223)
    assert calls == [("http://127.0.0.1:7700/displays/1/wake", "Bearer unit-test-only")]
    monkeypatch.setattr(cdp_proxy, "_port_open", lambda port: True)
    cdp_proxy._ensure_chrome(1, 9223)
    assert len(calls) == 1
    cdp_proxy._touch(1)
    assert (tmp_path / "cdp-1").exists()


def test_rewake_after_reaper_brings_supervised_services_up_before_waiting_for_x(monkeypatch, tmp_path):
    """After the idle reaper the xvfb/wm/panels services stay supervised but wanted down; a
    rescan alone leaves X down, so waking again must ask s6 for them before waiting."""
    monkeypatch.syspath_prepend(str(ROOT / "services/computer/src"))
    for name in ("workspace", "pure", "desktops", "browser", "fixtureserver", "cdp_proxy"):
        monkeypatch.delitem(sys.modules, name, raising=False)
    monkeypatch.setenv("COMPUTER_TOKEN", "unit-test-only")
    import desktops as module
    calls = []
    monkeypatch.setattr(module, "_write_service", lambda name, script, down=False: None)
    monkeypatch.setattr(module, "_rescan", AsyncMock(side_effect=lambda: calls.append(("rescan",))))
    monkeypatch.setattr(module, "_svc", AsyncMock(side_effect=lambda *a: calls.append(a)))
    monkeypatch.setattr(module, "_wait_x", AsyncMock(side_effect=lambda n, *a: calls.append(("wait_x", n))))
    monkeypatch.setattr(module.workspace, "desktop_identity", lambda bot: (1000, tmp_path / "bot", tmp_path))
    monkeypatch.setattr(module.asyncio, "sleep", AsyncMock())
    monkeypatch.setattr(module.Path, "exists", lambda self: str(self).startswith("/run/service/") and str(self).endswith("/supervise"))
    desk = module.Desktop(bot_id="bot-a", display=1, name="Ada")
    asyncio.run(module.DesktopManager()._spawn_display(desk))
    ups = [c[1].rsplit("/", 1)[1] for c in calls if c[0] == "-u"]
    assert ups == ["xvfb-1", "wm-1", "panels-1"]
    assert calls.index(("wait_x", 1)) > max(i for i, c in enumerate(calls) if c[0] == "-u")
