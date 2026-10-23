import os
import datetime as dt
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
    r = session.post(f"{API}/api/bots", json={"name": "Zone test"})
    assert r.status_code in (200, 201), r.text
    body = r.json()
    b = body.get("bot", body)
    yield b
    session.delete(f"{API}/api/bots/{b['id']}")


def test_user_default_zone_is_karachi(session):
    assert session.get(f"{API}/api/auth/me").json()["timezone"] == "Asia/Karachi"


def test_routine_next_run_uses_the_zone(session, bot):
    r = session.post(f"{API}/api/bots/{bot['id']}/routines", json={"name": "Brief", "cron": "0 8 * * *", "instruction": "Say hi.", "timezone": "Asia/Karachi"})
    assert r.status_code == 200, r.text
    nxt = dt.datetime.fromisoformat(r.json()["nextRunAt"].replace("Z", "+00:00")).astimezone(dt.timezone.utc)
    assert (nxt.hour, nxt.minute) == (3, 0)
    rows = session.get(f"{API}/api/bots/{bot['id']}/routines").json()
    assert rows[0]["nextRunAt"] or rows[0].get("next_run_at")


def test_default_zone_applies_when_none_given(session, bot):
    r = session.post(f"{API}/api/bots/{bot['id']}/routines", json={"name": "Brief", "cron": "30 9 * * *", "instruction": "Say hi."})
    nxt = dt.datetime.fromisoformat(r.json()["nextRunAt"].replace("Z", "+00:00")).astimezone(dt.timezone.utc)
    assert (nxt.hour, nxt.minute) == (4, 30)


def test_invalid_cron_is_a_400_not_a_500(session, bot):
    r = session.post(f"{API}/api/bots/{bot['id']}/routines", json={"name": "Bad", "cron": "nonsense", "instruction": "x"})
    assert r.status_code == 400


def test_timezone_can_be_changed_and_validated(session):
    assert session.patch(f"{API}/api/auth/timezone", json={"timezone": "Mars/Olympus"}).status_code == 400
    assert session.patch(f"{API}/api/auth/timezone", json={"timezone": "Asia/Karachi"}).status_code == 200
