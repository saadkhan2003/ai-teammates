"""Install, connect, and call a plugin through the policy gate."""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

from stack import BASE
from stack import API
OWNER = os.environ.get("OWNER_USERNAME", "saad")
PASSWORD = os.environ.get("OWNER_PASSWORD", "teammates-dev")
WORKER = os.environ.get("WORKER_TOKEN", "dev-worker-token-change-me")
CANARY = "plugin-canary-key-9911"


class Client:
    def __init__(self) -> None:
        self.cookie = ""

    def call(self, method: str, path: str, body=None, auth=True, base=BASE, headers=None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(base + path, data=data, method=method)
        if body is not None:
            request.add_header("Content-Type", "application/json")
        if auth and self.cookie:
            request.add_header("Cookie", self.cookie)
        for key, value in (headers or {}).items():
            request.add_header(key, value)
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                set_cookie = response.headers.get("Set-Cookie", "")
                if "teammates_session=" in set_cookie:
                    self.cookie = set_cookie.split(";", 1)[0]
                text = response.read().decode()
                parsed = json.loads(text) if text and "json" in (response.headers.get("Content-Type") or "") else text
                return response.status, parsed
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode()
            try:
                parsed = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                parsed = raw
            return exc.code, parsed


def login() -> Client:
    # Share the owner session with the other suites (login is rate limited).
    from test_acceptance import login as owner_login

    client = Client()
    client.cookie = owner_login().cookie
    return client


def test_install_connect_call_and_audit(bot_factory):
    owner = login()
    status, catalog = owner.call(
        "POST",
        "/api/admin/plugins",
        {
            "name": "Echo bench",
            "kind": "builtin",
            "transport": "builtin",
            "authType": "none",
            "category": "Built-in",
            "tools": [
                {"name": "echo", "description": "Return the arguments"},
                {"name": "send_payment", "description": "Charge the card"},
            ],
        },
    )
    assert status == 200, catalog
    assert catalog["label"] == "auto-checked", catalog
    assert "value" not in catalog
    catalog_id = catalog["id"]

    status, blocked_row = owner.call(
        "POST",
        "/api/admin/plugins",
        {
            "name": "Blocked bench",
            "kind": "builtin",
            "transport": "builtin",
            "authType": "none",
            "dedupeKey": "builtin:blocked-bench",
            "tools": [{"name": "echo", "description": "Echo"}],
        },
    )
    assert status == 200, blocked_row
    status, block = owner.call("POST", f"/api/admin/plugins/{blocked_row['id']}/block", {"blocked": True, "reason": "blocked by an admin"})
    assert status == 200 and block["blocked"] is True, block
    status, refused = owner.call("POST", "/api/plugins/install", {"catalogId": blocked_row["id"]})
    assert status == 403, refused

    status, keyed = owner.call(
        "POST",
        "/api/admin/plugins",
        {
            "name": "Keyed bench",
            "kind": "builtin",
            "transport": "builtin",
            "authType": "api_key",
            "dedupeKey": "builtin:keyed-bench",
            "tools": [{"name": "echo", "description": "Echo"}],
        },
    )
    assert status == 200 and keyed["label"] == "needs-auth", keyed
    status, installed_key = owner.call("POST", "/api/plugins/install", {"catalogId": keyed["id"]})
    assert status == 200, installed_key
    status, connected = owner.call(
        "POST",
        f"/api/plugins/{installed_key['id']}/connect",
        {"apiKey": CANARY},
    )
    assert status == 200, connected
    raw = json.dumps(connected)
    assert CANARY not in raw
    assert connected["connected"] is True
    assert connected["secretId"]
    status, oauth = owner.call("POST", f"/api/plugins/{installed_key['id']}/oauth/start", {})
    assert status == 400, oauth

    status, installed = owner.call("POST", "/api/plugins/install", {"catalogId": catalog_id})
    assert status == 200, installed
    status, again = owner.call("POST", "/api/plugins/install", {"catalogId": catalog_id})
    assert status == 200 and again["id"] == installed["id"], again

    status, bots = owner.call("GET", "/api/bots")
    assert status == 200, bots
    if isinstance(bots, list) and bots:
        bot_id = bots[0]["id"]
    else:
        bot_id = bot_factory(owner, "Plugin clerk", "Calls plugins")
    status, enabled = owner.call("PUT", f"/api/plugins/{installed['id']}/bots/{bot_id}", {"enabled": True})
    assert status == 200 and enabled["enabled"] is True, enabled

    status, tools = owner.call(
        "GET",
        f"/internal/bots/{bot_id}/plugin-tools",
        base=API,
        headers={"Authorization": "Bearer " + WORKER},
    )
    assert status == 200, tools
    names = [item["name"] for item in tools["tools"]]
    assert names and all(name.startswith("plugin_") for name in names)
    assert len(names) <= 24
    assert CANARY not in json.dumps(tools)

    echo = next(name for name in names if name.endswith("_echo"))
    payment = next(name for name in names if "send_payment" in name)
    status, called = owner.call("POST", f"/api/plugins/{installed['id']}/call", {"botId": bot_id, "tool": echo, "args": {"note": "hello-v03"}})
    assert status == 200 and called["ok"] is True, called
    output = called["output"]
    if isinstance(output, dict) and output.get("replayed") and isinstance(output.get("output"), dict):
        output = output["output"]
    assert output["tool"] == "echo"
    assert CANARY not in json.dumps(called)

    status, asked = owner.call(
        "POST",
        f"/api/plugins/{installed['id']}/call",
        {"botId": bot_id, "tool": payment, "args": {"amount": "1"}},
    )
    assert status == 200 and asked["status"] == "waiting_approval", asked
    assert asked["riskClass"] == "payment"

    status, audit = owner.call(
        "GET",
        "/internal/test/plugin-audit",
        base=API,
        headers={"Authorization": "Bearer " + WORKER},
    )
    assert status == 200, audit
    blob = json.dumps(audit)
    assert CANARY not in blob
    actions = [row["action"] for row in audit]
    assert "plugin.call" in actions
    assert "plugin.ask" in actions
    assert "plugin.connect" in actions
    assert "plugin.install" in actions
    assert "plugin.block" in actions
