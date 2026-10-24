"""Account profile, ticket ownership, and staff support workflows."""
from __future__ import annotations

import time

from test_v02 import OWNER, PASSWORD, Client, login


def invite_member(owner: Client, suffix: str) -> Client:
    name = f"acct{suffix}{int(time.time())}"
    status, invite = owner.call("POST", "/api/invitations", {"email": f"{name}@example.test", "role": "member"})
    assert status == 200 and invite.get("token"), invite
    member = Client()
    status, result = member.call("POST", "/api/invitations/accept", {"token": invite["token"], "username": name, "password": "member-password-1"}, auth=False)
    assert status == 200, result
    return member


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
