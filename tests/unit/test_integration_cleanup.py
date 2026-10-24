"""Exercise integration setup/teardown without a stack, credentials, or Docker."""
import runpy
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def helpers(monkeypatch):
    acceptance = types.ModuleType("test_acceptance")
    for name in ("login", "submit", "wait_task", "_psql"):
        setattr(acceptance, name, lambda *args: None)
    acceptance.API = "http://unit.invalid"
    acceptance.OPENROUTER = "mock-only"
    monkeypatch.setitem(sys.modules, "test_acceptance", acceptance)
    return runpy.run_path(str(ROOT / "tests/integration/test_bot_messaging.py"))


@pytest.mark.parametrize("remaining,stopped", [([], True), ([{"id": "shared-bot"}], False)])
def test_cleanup_stops_only_an_unused_owner_computer(monkeypatch, remaining, stopped):
    module = helpers(monkeypatch)
    calls = []

    class Client:
        def call(self, method, path, body=None):
            calls.append((method, path))
            if method == "DELETE":
                return 204, ""
            return 200, remaining if method == "GET" else {"status": "stopped"}

    module["_cleanup"](Client(), "fixture-bot")
    assert calls[:2] == [("DELETE", "/api/bots/fixture-bot"), ("GET", "/api/bots")]
    assert (("POST", "/api/computer/stop") in calls) is stopped


@pytest.mark.parametrize("status", [200, 503])
def test_factory_releases_computer_even_after_provisioning_assertion(monkeypatch, status):
    cleanup = []
    module = types.ModuleType("test_bot_messaging")
    module._cleanup = lambda client, bot: cleanup.append(bot)
    monkeypatch.setitem(sys.modules, "test_bot_messaging", module)
    fixture = runpy.run_path(str(ROOT / "tests/integration/conftest.py"))["bot_factory"]
    lifecycle = fixture.__wrapped__()
    factory = next(lifecycle)
    client = types.SimpleNamespace(call=lambda *args: (status, {"id": "persisted-bot"}))
    if status == 200:
        assert factory(client, "Test") == "persisted-bot"
    else:
        with pytest.raises(AssertionError):
            factory(client, "Test")
    with pytest.raises(StopIteration):
        next(lifecycle)
    assert cleanup == ["persisted-bot"]


@pytest.mark.parametrize("prompt,paths", [
    ("LONG RUN DEMO 2 SLOW", ["/workspace/long-run-step-00001.txt", "/workspace/long-run-step-00002.txt"]),
    ("POISON STEP DEMO", ["/workspace/poison-before.txt"]),
    ("SHELL APPEND DEMO", []),
])
def test_chaos_setup_grants_only_the_scripted_file_paths(monkeypatch, prompt, paths):
    helpers(monkeypatch)
    granted = []
    resume = types.ModuleType("test_long_run_resume")
    resume._allow_write_paths = lambda bot, values: granted.extend(values)
    monkeypatch.setitem(sys.modules, "test_long_run_resume", resume)
    bots = types.ModuleType("test_bot_messaging")
    bots._bot = lambda *args: "fixture-bot"
    bots._workspace = lambda *args: {"conversationId": "conversation"}
    bots._approval = lambda *args: None
    bots._cleanup = lambda *args: None
    monkeypatch.setitem(sys.modules, "test_bot_messaging", bots)
    acceptance = sys.modules["test_acceptance"]
    acceptance.login = lambda: types.SimpleNamespace(call=lambda *args: (200, {}))
    acceptance.submit = lambda *args: "task"
    module = runpy.run_path(str(ROOT / "tests/integration/test_long_run_chaos.py"))
    assert module["_demo"](prompt)[1:] == ("fixture-bot", "task")
    assert granted == paths
