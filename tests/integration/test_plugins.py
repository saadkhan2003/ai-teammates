"""One plugin registry: aliases, create, list, delete. No catalog import."""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request

from stack import BASE
OWNER = os.environ.get("OWNER_USERNAME", "saad")
PASSWORD = os.environ.get("OWNER_PASSWORD", "teammates-dev")


class Client:
    def __init__(self) -> None:
        self.cookie = ""

    def call(self, method: str, path: str, body=None, auth=True):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(BASE + path, data=data, method=method)
        if body is not None:
            request.add_header("Content-Type", "application/json")
        if auth and self.cookie:
            request.add_header("Cookie", self.cookie)
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                set_cookie = response.headers.get("Set-Cookie", "")
                if "teammates_session=" in set_cookie:
                    self.cookie = set_cookie.split(";", 1)[0]
                text = response.read().decode()
                if "application/json" in (response.headers.get("Content-Type") or "") and text:
                    return response.status, json.loads(text)
                return response.status, text
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode()
            try:
                parsed = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                parsed = raw
            return exc.code, parsed


def login(username: str, password: str) -> Client:
    if username == OWNER and password == PASSWORD:
        # Share the owner session with the other suites (login is rate limited).
        from test_acceptance import login as owner_login

        client = Client()
        client.cookie = owner_login().cookie
        return client
    client = Client()
    status, body = client.call("POST", "/api/auth/login", {"username": username, "password": password}, auth=False)
    assert status == 200, body
    return client


def test_plugin_registry_and_credential_aliases():
    owner = login(OWNER, PASSWORD)
    stamp = str(int(time.time()))
    status, secret = owner.call(
        "POST",
        "/api/secrets",
        {
            "name": f"stripe-{stamp}",
            "namespace": "plugin",
            "type": "CONNECTOR_CREDENTIAL",
            "value": "not-a-real-token",
            "allowedTools": ["plugin:stripe"],
        },
    )
    assert status == 200, secret
    assert secret["type"] == "PLUGIN_CREDENTIAL", secret

    status, oauth = owner.call(
        "POST",
        "/api/secrets",
        {
            "name": f"oauth-{stamp}",
            "namespace": "plugin",
            "type": "OAUTH_CREDENTIAL",
            "value": "not-a-refresh-token",
        },
    )
    assert status == 200 and oauth["type"] == "PLUGIN_CREDENTIAL", oauth

    status, listed = owner.call("GET", "/api/secrets")
    assert status == 200
    row = next(item for item in listed if item["id"] == secret["id"])
    assert row["type"] == "PLUGIN_CREDENTIAL"
    assert "not-a-real-token" not in json.dumps(row)

    status, plugin = owner.call(
        "POST",
        "/api/plugins",
        {
            "name": f"Stripe {stamp}",
            "kind": "streamable-http",
            "authType": "oauth",
            "category": "Dev tools",
            "trust": "official",
            "secretId": secret["id"],
            "baseUrl": "https://mcp.example.test",
            "manifest": {"transport": "streamable-http"},
        },
    )
    assert status == 200, plugin
    assert plugin["kind"] == "mcp", plugin
    assert plugin["authType"] == "oauth"
    assert plugin["label"] == "listed"
    assert plugin["status"] == "installed"
    assert plugin["trust"] == "official"

    status, plugins = owner.call("GET", "/api/plugins")
    assert status == 200 and any(item["id"] == plugin["id"] for item in plugins), plugins

    status, bad = owner.call("POST", "/api/plugins", {"name": "nope", "label": "validated"})
    assert status == 400, bad

    status, removed = owner.call("DELETE", f"/api/plugins/{plugin['id']}")
    assert status == 200, removed
    status, plugins = owner.call("GET", "/api/plugins")
    assert all(item["id"] != plugin["id"] for item in plugins)

    status, missing = owner.call("DELETE", f"/api/plugins/{plugin['id']}")
    assert status == 404, missing
