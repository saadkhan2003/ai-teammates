"""v0.3: YAML specs, outbound replay, and OAuth against the in-process mock provider."""
from __future__ import annotations

import json
import urllib.request
from urllib.error import HTTPError

from test_plugin_catalog import API, PASSWORD, OWNER, Client, login


YAML = """
openapi: 3.0.3
info:
  title: Notes
  version: "1"
servers:
  - url: https://notes.example.com
paths:
  /notes:
    get:
      operationId: list_notes
      summary: List notes
"""


def _no_redirect(url: str):
    class Handler(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None

    opener = urllib.request.build_opener(Handler)
    try:
        with opener.open(url, timeout=30) as response:
            return response.status, response.geturl()
    except HTTPError as exc:
        return exc.code, exc.headers.get("Location") or ""


def test_yaml_outbound_replay_and_oauth_mock():
    owner = login()
    status, spec = owner.call(
        "POST",
        "/api/plugins/openapi",
        {"spec": YAML, "sourceUrl": "https://notes.example.com/openapi.yaml"},
    )
    assert status == 200, spec
    assert "list_notes" in spec["tools"]

    status, catalog = owner.call(
        "POST",
        "/api/admin/plugins",
        {
            "name": "Notes writer",
            "kind": "builtin",
            "transport": "builtin",
            "authType": "none",
            "dedupeKey": "builtin:v03-notes-writer",
            "tools": [{"name": "create_note", "description": "Create a note", "method": "POST"}],
        },
    )
    assert status == 200, catalog
    status, installed = owner.call("POST", "/api/plugins/install", {"catalogId": catalog["id"]})
    assert status == 200, installed
    status, bots = owner.call("GET", "/api/bots")
    assert status == 200 and bots, bots
    bot_id = bots[0]["id"]
    status, enabled = owner.call("PUT", f"/api/plugins/{installed['id']}/bots/{bot_id}", {"enabled": True})
    assert status == 200, enabled
    body = {"botId": bot_id, "tool": "create_note", "args": {"title": "one"}}
    status, first = owner.call("POST", f"/api/plugins/{installed['id']}/call", body)
    assert status == 200 and first["ok"] is True, first
    status, second = owner.call("POST", f"/api/plugins/{installed['id']}/call", body)
    assert status == 200 and second["ok"] is True, second
    assert second["output"]["replayed"] is True
    status, outbound = owner.call("GET", "/api/admin/outbound-actions")
    assert status == 200, outbound
    rows = outbound if isinstance(outbound, list) else []
    creates = [row for row in rows if row.get("kind") == "plugin_write" and row.get("status") == "completed"]
    assert creates, rows

    status, oauth_row = owner.call(
        "POST",
        "/api/admin/plugins",
        {
            "name": "Mock mail",
            "kind": "builtin",
            "transport": "builtin",
            "authType": "oauth",
            "dedupeKey": "builtin:v03-mock-mail",
            "oauthAuthorize": API + "/internal/test/oauth/authorize",
            "oauthToken": "mock://oauth",
            "tools": [{"name": "list_mail", "description": "List mail", "method": "GET"}],
        },
    )
    assert status == 200, oauth_row
    status, oauth_install = owner.call("POST", "/api/plugins/install", {"catalogId": oauth_row["id"]})
    assert status == 200, oauth_install
    api = Client()
    status, session = api.call("POST", "/api/auth/login", {"username": OWNER, "password": PASSWORD}, auth=False, base=API)
    assert status == 200, session
    status, started = api.call("POST", f"/api/plugins/{oauth_install['id']}/oauth/start", {}, base=API)
    assert status == 200 and "url" in started, started
    code, location = _no_redirect(started["url"])
    assert code in (302, 301), location
    assert "code=" in location
    code, final = _no_redirect(location)
    assert "connected=1" in (final or ""), (code, final)
    status, installs = owner.call("GET", "/api/plugins")
    assert status == 200, installs
    match = next(row for row in installs if row["id"] == oauth_install["id"])
    blob = json.dumps(match)
    assert "mock-access-token" not in blob
    assert match.get("secretId") or match.get("secret_id")
