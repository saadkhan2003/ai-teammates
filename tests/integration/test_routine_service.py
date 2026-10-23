"""The panel's HTTP routes share one RoutineService with the bot tools: same validation, same limits."""
import datetime as dt
import os

import pytest
import requests

API = os.environ.get("API_URL", "http://127.0.0.1:18081")
USER = os.environ.get("OWNER_USERNAME", "saad")
PASSWORD = os.environ.get("OWNER_PASSWORD", "teammates-dev")


@pytest.fixture()
def session():
    s = requests.Session()
    r = s.post(f"{API}/api/auth/login", json={"username": USER, "password": PASSWORD})
    assert r.status_code == 200, r.text
    return s


@pytest.fixture()
def bot(session):
    r = session.post(f"{API}/api/bots", json={"name": "Service test"})
    assert r.status_code in (200, 201), r.text
    body = r.json()
    b = body.get("bot", body)
    yield b
    session.delete(f"{API}/api/bots/{b['id']}")


def make(session, bot, **fields):
    payload = {"name": "Brief", "cron": "0 8 * * *", "instruction": "Say hi."}
    payload.update(fields)
    return session.post(f"{API}/api/bots/{bot['id']}/routines", json=payload)


def test_invalid_and_too_frequent_schedules_are_refused_with_a_sentence(session, bot):
    bad = make(session, bot, cron="nonsense")
    assert bad.status_code == 400 and bad.json()["error"] == "invalid_cron"
    fast = make(session, bot, cron="*/4 * * * *")
    assert fast.status_code == 400 and fast.json()["error"] == "interval_too_short"
    ok = make(session, bot, cron="*/5 * * * *")
    assert ok.status_code == 200, ok.text


def test_ten_routines_per_bot(session, bot):
    for i in range(10):
        assert make(session, bot, name=f"R{i}").status_code == 200
    over = make(session, bot, name="one too many")
    assert over.status_code == 400 and over.json()["error"] == "routine_limit"


def test_one_off_reminder_has_a_run_time_and_no_cron_loop(session, bot):
    when = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=45)).isoformat()
    r = make(session, bot, cron=None, runAt=when, name="Stretch")
    assert r.status_code == 200, r.text
    routine = r.json()["routine"]
    assert routine["kind"] == "once" and routine["enabled"] is True
    assert routine["nextRunAt"].startswith(when[:16])
    past = make(session, bot, cron=None, runAt="2020-01-01T00:00:00Z")
    assert past.status_code == 400 and past.json()["error"] == "run_at_in_past"


def test_get_one_routine_and_delete_it(session, bot):
    rid = make(session, bot).json()["id"]
    got = session.get(f"{API}/api/routines/{rid}")
    assert got.status_code == 200 and got.json()["name"] == "Brief" and got.json()["runs"] == []
    assert "Every day at 8:00 AM" in got.json()["human"]
    assert session.delete(f"{API}/api/routines/{rid}").status_code == 200
    assert session.get(f"{API}/api/routines/{rid}").status_code == 404


def test_edit_fields_recompute_the_next_run(session, bot):
    rid = make(session, bot).json()["id"]
    r = session.patch(f"{API}/api/routines/{rid}", json={"cron": "30 9 * * *"})
    assert r.status_code == 200, r.text
    assert r.json()["routine"]["after"]["cron"] == "30 9 * * *"
    assert r.json()["routine"]["after"]["nextRunAt"][11:16] == "04:30"
