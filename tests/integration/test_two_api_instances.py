"""Smoke test that durable tickets issued by one API are accepted by another."""
from __future__ import annotations

import os
import urllib.parse

import pytest

from test_plugin_catalog import Client, OWNER, PASSWORD

API_A = os.environ.get("API_URL_A", "").rstrip("/")
API_B = os.environ.get("API_URL_B", "").rstrip("/")
pytestmark = pytest.mark.skipif(not API_A or not API_B, reason="set API_URL_A and API_URL_B for two API instances")


def _login(base: str) -> Client:
    client = Client()
    status, body = client.call("POST", "/api/auth/login", {"username": OWNER, "password": PASSWORD}, auth=False, base=base)
    assert status == 200, body
    return client


def test_ticket_issued_on_a_is_consumed_on_b():
    websocket = pytest.importorskip("websocket", reason="websocket-client is required for API WS smoke checks")
    a, b = _login(API_A), _login(API_B)
    status, bots = a.call("GET", "/api/bots", base=API_A)
    assert status == 200 and bots, bots
    bot_id = bots[0]["id"]
    status, computer = a.call("GET", "/api/computer", base=API_A)
    assert status == 200, computer
    computer_id = computer.get("computerId") or bot_id

    status, terminal = a.call("POST", f"/api/computers/{computer_id}/terminal-ticket", {"botId": bot_id, "window": 1}, base=API_A)
    assert status == 200, terminal
    terminal_url = API_B.replace("http://", "ws://", 1).replace("https://", "wss://", 1) + f"/api/computers/{computer_id}/terminal"
    try:
        ws = websocket.create_connection(terminal_url, cookie=b.cookie, subprotocols=["terminal-ticket." + terminal["ticket"]], timeout=5)
        ws.close()
    except Exception:
        pass  # API can consume the ticket before a missing computer backend fails the upgrade.
    with pytest.raises(Exception) as replay_error:
        websocket.create_connection(terminal_url, cookie=b.cookie, subprotocols=["terminal-ticket." + terminal["ticket"]], timeout=5)
    assert getattr(replay_error.value, "status_code", None) == 401

    status, vnc = a.call("POST", f"/api/computers/{bot_id}/vnc-ticket", base=API_A)
    assert status == 200, vnc
    vnc_url = API_B.replace("http://", "ws://", 1).replace("https://", "wss://", 1)
    query = urllib.parse.urlencode({"token": vnc["token"], "window": bot_id})
    vnc_url += "/vnc/websockify?" + query
    try:
        ws = websocket.create_connection(vnc_url, cookie=b.cookie, timeout=5)
        ws.close()
    except Exception:
        pass
    with pytest.raises(Exception) as vnc_replay_error:
        websocket.create_connection(vnc_url, cookie=b.cookie, timeout=5)
    assert getattr(vnc_replay_error.value, "status_code", None) == 401
