"""PATCH /api/routines/{id} enabled: disabling clears the schedule, enabling recomputes it from now."""
from test_plugin_catalog import login


def test_routine_enable_disable_roundtrip():
    owner = login()
    status, bot = owner.call("POST", "/api/bots", {"name": "Routine toggle"})
    assert status in (200, 201), bot
    bot_id = bot["id"]
    try:
        status, made = owner.call("POST", f"/api/bots/{bot_id}/routines", {"name": "Daily", "cron": "0 8 * * *", "instruction": "brief"})
        assert status in (200, 201), made
        rid = made["id"]

        def routine():
            status, rows = owner.call("GET", f"/api/bots/{bot_id}/routines")
            assert status == 200, rows
            return next(r for r in rows if r["id"] == rid)

        assert routine()["enabled"] is True
        status, off = owner.call("PATCH", f"/api/routines/{rid}", {"enabled": False})
        assert status == 200 and off["enabled"] is False, off
        row = routine()
        assert row["enabled"] is False
        assert not row.get("nextRunAt") and not row.get("next_run_at")
        status, on = owner.call("PATCH", f"/api/routines/{rid}", {"enabled": True})
        assert status == 200 and on["enabled"] is True and on["nextRunAt"], on
        row = routine()
        assert row["enabled"] is True
        assert row.get("nextRunAt") or row.get("next_run_at")
        status, _ = owner.call("PATCH", "/api/routines/00000000-0000-0000-0000-000000000001", {"enabled": False})
        assert status in (401, 404)
    finally:
        owner.call("DELETE", f"/api/bots/{bot_id}")
