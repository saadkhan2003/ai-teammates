"""API cleanup for tests that allocate computers for disposable owners."""
import pytest


@pytest.fixture
def bot_factory():
    from test_bot_messaging import _cleanup

    created = []

    def create(client, name, role="test"):
        status, bot = client.call("POST", "/api/bots", {"name": name, "role": role})
        # A failed provisioning response can still contain a persisted bot id.
        # Register it before asserting so fixture teardown also handles failures.
        if isinstance(bot, dict) and bot.get("id"):
            created.append((client, bot["id"]))
        assert status == 200, f"bot creation failed: HTTP {status}"
        return bot["id"]

    try:
        yield create
    finally:
        errors = []
        for client, bot in reversed(created):
            try:
                _cleanup(client, bot)
            except Exception as exc:
                errors.append(type(exc).__name__)
        assert not errors, f"bot/computer teardown failed: {errors}"
