"""Account profile, ticket ownership, and staff support workflows."""
from __future__ import annotations

import time
import base64
import hashlib
import hmac
import json
import urllib.error
import urllib.request

from stack import BASE
from test_v02 import OWNER, PASSWORD, Client, login


def invite_member(owner: Client, suffix: str) -> Client:
    name = f"acct{suffix}{int(time.time())}"
    status, invite = owner.call("POST", "/api/invitations", {"email": f"{name}@example.test", "role": "member"})
    assert status == 200 and invite.get("token"), invite
    member = Client()
    status, result = member.call("POST", "/api/invitations/accept", {"token": invite["token"], "username": name, "password": "member-password-1"}, auth=False)
    assert status == 200, result
    member.username = name
    return member


def raw_call(method: str, path: str, body=None, cookie: str = ""):
    request = urllib.request.Request(BASE + path, data=None if body is None else json.dumps(body).encode(), method=method)
    if body is not None:
        request.add_header("Content-Type", "application/json")
    if cookie:
        request.add_header("Cookie", cookie)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read().decode()
            return response.status, json.loads(raw) if raw else {}, response.headers.get_all("Set-Cookie") or []
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode() or "{}"), exc.headers.get_all("Set-Cookie") or []


def totp_code(secret: str) -> str:
    key = base64.b32decode(secret + "=" * ((8 - len(secret) % 8) % 8))
    counter = int(time.time()) // 30
    digest = hmac.new(key, counter.to_bytes(8, "big"), hashlib.sha1).digest()
    offset = digest[-1] & 0x0f
    number = (int.from_bytes(digest[offset:offset + 4], "big") & 0x7fffffff) % 1_000_000
    return f"{number:06d}"


def test_profile_ticket_owner_scope_and_staff_support():
    owner = login(OWNER, PASSWORD)
    first = invite_member(owner, "a")
    second = invite_member(owner, "b")
    status, profile = first.call("GET", "/api/account")
    assert status == 200 and profile["username"].startswith("accta"), profile
    status, saved = first.call("PUT", "/api/account/profile", {"displayName": "Account Test", "timezone": "Asia/Karachi", "locale": "ur", "notifications": {"email": False}})
    assert status == 200, saved
    status, email = first.call("POST", "/api/account/email", {"email": "changed@example.test"})
    assert status == 200 and email["verificationSent"] is False, email

    status, created = first.call("POST", "/api/support/tickets", {"category": "bug", "subject": "Account test issue", "message": "This is a sample support ticket."})
    assert status == 200, created
    ticket_id = created["id"]
    status, tickets = first.call("GET", "/api/support/tickets")
    assert status == 200 and any(row["id"] == ticket_id for row in tickets), tickets
    status, hidden = second.call("GET", f"/api/support/tickets/{ticket_id}")
    assert status == 404, hidden
    status, forbidden = first.call("GET", "/api/admin/support/tickets")
    assert status == 403, forbidden

    status, listed = owner.call("GET", "/api/admin/support/tickets")
    assert status == 200 and any(row["id"] == ticket_id for row in listed), listed
    status, reply = owner.call("POST", f"/api/admin/support/tickets/{ticket_id}/messages", {"message": "We received your request."})
    assert status == 200, reply
    status, detail = first.call("GET", f"/api/support/tickets/{ticket_id}")
    assert status == 200 and any(message["is_staff"] for message in detail["messages"]), detail
    status, changed = owner.call("PATCH", f"/api/admin/support/tickets/{ticket_id}", {"status": "in_progress"})
    assert status == 200, changed


def test_password_change_and_immediate_account_deletion():
    owner = login(OWNER, PASSWORD)
    account = invite_member(owner, "delete")
    status, profile = account.call("GET", "/api/account")
    assert status == 200, profile
    status, changed = account.call("POST", "/api/account/password", {"currentPassword": "member-password-1", "newPassword": "new-member-password-2"})
    assert status == 200, changed
    status, wrong = Client().call("POST", "/api/auth/login", {"username": profile["username"], "password": "member-password-1"}, auth=False)
    assert status == 401, wrong
    status, valid = Client().call("POST", "/api/auth/login", {"username": profile["username"], "password": "new-member-password-2"}, auth=False)
    assert status == 200, valid

    status, refused = account.call("DELETE", "/api/account", {"confirmation": "delete my account", "password": "new-member-password-2"})
    assert status == 400, refused
    status, deleted = account.call("DELETE", "/api/account", {"confirmation": "DELETE MY ACCOUNT", "password": "new-member-password-2"})
    assert status == 200 and deleted["policy"] == "immediate", deleted
    status, gone = account.call("GET", "/api/account")
    assert status == 401, gone


def test_totp_is_required_at_login_and_recovery_codes_are_issued_once():
    owner = login(OWNER, PASSWORD)
    account = invite_member(owner, "otp")
    status, setup = account.call("POST", "/api/account/totp/setup", {})
    assert status == 200 and setup.get("otpauth"), setup
    status, enabled = account.call("POST", "/api/account/totp/verify", {"code": totp_code(setup["secret"])})
    assert status == 200 and len(enabled["recoveryCodes"]) == 8, enabled
    status, logout = account.call("POST", "/api/auth/logout", {})
    assert status == 200, logout

    status, prompt, cookies = raw_call("POST", "/api/auth/login", {"username": account.username, "password": "member-password-1"})
    assert status == 200 and prompt.get("totpRequired") is True, prompt
    challenge_cookie = next((part.split(";", 1)[0] for part in cookies if part.startswith("teammates_login_challenge=")), "")
    assert challenge_cookie
    status, verified, cookies = raw_call("POST", "/api/auth/login/totp", {"code": totp_code(setup["secret"])}, challenge_cookie)
    assert status == 200, verified
    session_cookie = next((part.split(";", 1)[0] for part in cookies if part.startswith("teammates_session=")), "")
    assert session_cookie
    account.cookie = session_cookie
    status, account_row = account.call("GET", "/api/account")
    assert status == 200 and account_row["totpEnabled"] is True, account_row
