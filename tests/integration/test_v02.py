"""v0.2 private beta: invitations, roles, vault grants, quotas, admin usage."""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
import uuid

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
    client = Client()
    status, body = client.call("POST", "/api/auth/login", {"username": username, "password": password}, auth=False)
    assert status == 200, body
    return client


def test_invitations_roles_vault_and_admin():
    owner = login(OWNER, PASSWORD)
    status, me = owner.call("GET", "/api/auth/me")
    assert status == 200 and me["role"] == "owner", me

    status, health = owner.call("GET", "/api/admin/health")
    assert status == 200 and health["ok"] is True, health
    assert health["computerIsolation"] is True, health
    assert "users" in health and "stuckTasks" in health

    status, quota = owner.call("GET", "/api/quotas")
    assert status == 200 and quota["maxBots"] >= 1, quota
    assert quota["maxComputers"] == 1

    status, computer = owner.call("GET", "/api/computer")
    assert status == 200 and computer["status"] in {"absent", "running", "unknown", "provisioning", "idle", "hibernated", "stopped"}, computer
    if computer["status"] not in {"absent", "unknown"}:
        assert computer["diskQuotaBytes"] > 0, computer

    email = f"beta-{int(time.time())}@example.test"
    username = f"beta{int(time.time())}"
    status, invite = owner.call("POST", "/api/invitations", {"email": email, "role": "member"})
    assert status == 200 and invite.get("token"), invite

    member = Client()
    status, accepted = member.call(
        "POST",
        "/api/invitations/accept",
        {"token": invite["token"], "username": username, "password": "member-pass-1"},
        auth=False,
    )
    assert status == 200 and accepted["role"] == "member", accepted

    status, again = Client().call(
        "POST",
        "/api/invitations/accept",
        {"token": invite["token"], "username": username + "x", "password": "member-pass-1"},
        auth=False,
    )
    assert again and status == 410

    status, forbidden = member.call("GET", "/api/admin/health")
    assert status == 403, forbidden
    status, forbidden = member.call("POST", "/api/invitations", {"email": "nope@example.test", "role": "member"})
    assert status == 403, forbidden

    status, created = owner.call(
        "POST",
        "/api/secrets",
        {"namespace": "vault", "name": f"owner-{username}", "type": "TOKEN", "value": "owner-only-token-value"},
    )
    assert status == 200, created
    owner_secret = created["id"]

    status, missing = member.call("GET", f"/api/secrets/{owner_secret}")
    assert status == 404, missing
    status, listing = member.call("GET", "/api/secrets")
    assert status == 200
    assert all(item.get("id") != owner_secret for item in listing)

    granted = str(uuid.uuid4())
    other = str(uuid.uuid4())
    status, secret = member.call(
        "POST",
        "/api/secrets",
        {
            "namespace": "vault",
            "name": f"grant-{username}",
            "type": "TOKEN",
            "value": "member-token-value-99",
            "allowedBotIds": [granted],
        },
    )
    assert status == 200, secret
    status, allowed = member.call(
        "POST",
        f"/api/secrets/{secret['id']}/access",
        {"botId": granted, "tool": "http_connector:vault"},
    )
    assert status == 200 and allowed["allowed"] is True, allowed
    status, denied = member.call(
        "POST",
        f"/api/secrets/{secret['id']}/access",
        {"botId": other, "tool": "http_connector:vault"},
    )
    assert status == 200 and denied["allowed"] is False and denied["reason"] == "bot_not_allowed", denied
    status, cross = owner.call("POST", f"/api/secrets/{secret['id']}/access", {"botId": granted, "tool": "http_connector:vault"})
    assert status == 404, cross

    status, expired = member.call(
        "POST",
        "/api/secrets",
        {
            "namespace": "vault",
            "name": f"expired-{username}",
            "type": "GENERIC",
            "value": "expired-value",
            "expiresAt": "2000-01-01T00:00:00Z",
        },
    )
    assert status == 200, expired
    status, expiry = member.call(
        "POST",
        f"/api/secrets/{expired['id']}/access",
        {"tool": "http_connector:vault", "destination": "https://example.test/"},
    )
    assert status == 200 and expiry["reason"] == "expired", expiry

    status, patched = member.call(
        "PATCH",
        f"/api/secrets/{secret['id']}",
        {"allowedDomains": ["example.test"], "allowedTools": ["http_connector:vault"]},
    )
    assert status == 200, patched
    status, domain = member.call(
        "POST",
        f"/api/secrets/{secret['id']}/access",
        {"botId": granted, "tool": "http_connector:vault", "destination": "https://evil.test/"},
    )
    assert domain["reason"] == "domain_not_allowed", domain

    status, promoted = owner.call("PATCH", f"/api/admin/users/{accepted['id']}", {"role": "admin"})
    assert status == 200 and promoted["role"] == "admin", promoted
    status, users = member.call("GET", "/api/admin/users")
    assert status == 200 and any(row["username"] == username for row in users), users
    status, report = member.call("GET", "/api/admin/usage")
    assert status == 200 and any(row["username"] == OWNER for row in report), report

    status, blocked = member.call("PATCH", f"/api/admin/users/{me['id']}", {"status": "disabled"})
    assert status == 403, blocked

    status, disabled = owner.call("PATCH", f"/api/admin/users/{accepted['id']}", {"status": "disabled"})
    assert status == 200 and disabled["status"] == "disabled", disabled
    status, denied_login = Client().call("POST", "/api/auth/login", {"username": username, "password": "member-pass-1"}, auth=False)
    assert status == 403, denied_login
    owner.call("PATCH", f"/api/admin/users/{accepted['id']}", {"status": "active", "role": "member"})
