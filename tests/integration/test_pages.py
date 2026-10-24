"""Pages acceptance against the orchestrator's isolated mock stack."""
import hashlib
import json
import urllib.request
import uuid

import pytest
from test_acceptance import Client, _psql, login, submit, wait_task, worker_call
from test_bot_messaging import _workspace
from stack import BASE

MALICIOUS = '''# Untrusted report
<script>window.pagePwned=true; fetch('/api/bots'); document.cookie; top.location='/escaped'; parent.document.body.textContent='pwned'</script>
<img src="https://pages-exfil.invalid/pixel" onerror="fetch('/api/bots')">
[Jump](javascript:top.location='/escaped')
<iframe src="/api/bots"></iframe>
<form action="/api/bots" method="post"><input name="name" value="pwned"><button>Send</button></form>
<style>@import 'https://pages-exfil.invalid/style'; body{background:url(https://pages-exfil.invalid/css)}</style>
```page
{"type":"calculator","expression":"fetch('/api/bots')"}
```
'''


def _create(client, bot, source="# Private", **extra):
    payload = {"title": "Quarterly report", "kind": "report", "source": source, **extra}
    status, page = client.call("POST", f"/api/bots/{bot}/pages", payload)
    assert status == 200
    return page


def test_pages_versions_shares_hashes_revocation_and_audits(bot_factory):
    owner = login()
    bot = bot_factory(owner, "Pages" + uuid.uuid4().hex[:5])
    chat = _workspace(owner, bot)["conversationId"]
    first = _create(owner, bot, conversationId=chat)
    pid = first["id"]
    assert first["shareMode"] == "private" and first["version"] == 1
    status, updated = owner.call("PUT", f"/api/pages/{pid}", {"edits": [{"find": "Private", "replace": "Updated"}], "summary": "Changed heading"})
    assert status == 200 and updated["version"] == 2
    assert owner.call("GET", f"/api/pages/{pid}?version=1")[1]["source"] == "# Private"
    assert [v["version"] for v in owner.call("GET", f"/api/pages/{pid}/versions")[1]] == [2, 1]
    status, restored = owner.call("POST", f"/api/pages/{pid}/restore/1", {})
    assert status == 200 and restored["version"] == 3 and restored["source"] == "# Private"
    assert restored["summary"] == "Restored version 1"
    status, shares = owner.call("GET", f"/api/pages/{pid}/shares")
    assert status == 200 and shares == []
    status, link = owner.call("POST", f"/api/pages/{pid}/shares", {})
    assert status == 200
    token = link["url"].rsplit("/", 1)[1]
    stored_hash = _psql(f"SELECT token_hash FROM page_share_links WHERE id='{link['id']}'")
    assert stored_hash == hashlib.sha256(token.encode()).hexdigest() and stored_hash != token
    status, shared = Client().call("GET", "/api/public/pages/" + token, auth=False)
    assert status == 200 and shared["source"] == "# Private"
    assert not {"id", "ownerId", "botId", "conversationId", "owner_id", "bot_id"}.intersection(shared)
    assert Client().call("GET", f"/api/pages/{pid}", auth=False)[0] == 401
    assert owner.call("DELETE", f"/api/pages/{pid}/shares/{link['id']}")[0] == 204
    assert Client().call("GET", "/api/public/pages/" + token, auth=False)[0] == 404
    assert owner.call("GET", f"/api/pages/{pid}")[1]["shareMode"] == "private"
    assert owner.call("POST", f"/api/bots/{bot}/pages", {"title": "Too big", "kind": "report", "source": "💡" * 65537})[0] == 400
    assert owner.call("PUT", f"/api/pages/{pid}", {"edits": [{"find": "absent", "replace": "x"}], "summary": "Bad"})[0] == 400
    assert owner.call("GET", f"/api/pages/{pid}")[1]["version"] == 3
    assert owner.call("GET", f"/api/bots/{bot}/pages?q=Quarterly&kind=report")[1][0]["id"] == pid
    assert owner.call("GET", f"/api/bots/{bot}/pages?kind=tracker")[1] == []
    assert int(_psql(f"SELECT count(*) FROM audit_events WHERE action IN ('page.create','page.edit','page.restore','page.share','page.revoke') AND detail::text LIKE '%{pid}%'") or "0") == 5


def test_page_owner_scope_for_all_routes_and_bot_chat_boundary(bot_factory):
    owner = login()
    bot = bot_factory(owner, "PageScope" + uuid.uuid4().hex[:5])
    other_bot = bot_factory(owner, "PageOther" + uuid.uuid4().hex[:5])
    chat = _workspace(owner, bot)["conversationId"]
    first = _create(owner, bot, conversationId=chat)
    pid = first["id"]
    assert owner.call("GET", f"/api/bots/{other_bot}/pages")[1] == []
    other_chat = _workspace(owner, other_bot)["conversationId"]
    assert owner.call("POST", f"/api/bots/{other_bot}/pages", {"title": "Invalid scope", "kind": "report", "source": "body", "conversationId": chat})[0] == 404
    username = "pages-other-" + uuid.uuid4().hex[:8]
    worker_call("POST", "/internal/test/users", {"username": username, "password": "pages-test-only-password"})
    other = Client()
    try:
        assert other.call("POST", "/api/auth/login", {"username": username, "password": "pages-test-only-password"}, auth=False)[0] == 200
        for method, path, body in [
            ("GET", f"/api/bots/{bot}/pages", None), ("GET", f"/api/pages/{pid}", None),
            ("GET", f"/api/pages/{pid}/versions", None), ("GET", f"/api/pages/{pid}/shares", None),
            ("POST", f"/api/pages/{pid}/shares", {}), ("POST", f"/api/pages/{pid}/restore/1", {}),
            ("PUT", f"/api/pages/{pid}", {"source": "Attack", "summary": "Attack"}),
        ]:
            assert other.call(method, path, body)[0] == 404
        task = _psql(f"INSERT INTO tasks(bot_id,conversation_id,title,instruction,status,lease_owner,lease_until,lease_epoch) VALUES('{other_bot}','{other_chat}','Scope','Scope','running','pages-unit',now()+interval '1 hour',1) RETURNING id").splitlines()[0]
        envelope = {"taskId": task, "botId": other_bot, "epoch": 1, "tool": "edit_page", "args": {"page_id": pid, "source": "Attack", "summary": "Attack"}}
        result = worker_call("POST", "/internal/tools/execute", envelope)
        assert result["ok"] is False
        assert owner.call("GET", f"/api/pages/{pid}")[1]["version"] == 1
        with pytest.raises(AssertionError, match="409"):
            worker_call("POST", "/internal/tools/execute", dict(envelope, botId=bot))
    finally:
        _psql(f"DELETE FROM users WHERE username='{username}'")


def test_mock_chat_creates_page_and_followup_edits_same_id(bot_factory):
    owner = login()
    bot = bot_factory(owner, "PageChat" + uuid.uuid4().hex[:5])
    chat = _workspace(owner, bot)["conversationId"]
    first_task = submit(owner, chat, "Make a page with projects and a calculator", as_task=False)
    first_result = wait_task(owner, bot, first_task)
    assert first_result["status"] == "completed"
    pages = owner.call("GET", f"/api/bots/{bot}/pages")[1]
    assert len(pages) == 1 and pages[0]["current_version"] == 1
    pid = pages[0]["id"]
    second_task = submit(owner, chat, "Update the page", as_task=False)
    assert wait_task(owner, bot, second_task)["status"] == "completed"
    pages = owner.call("GET", f"/api/bots/{bot}/pages")[1]
    assert len(pages) == 1 and pages[0]["id"] == pid and pages[0]["current_version"] == 2
    assert any(m.get("page", {}).get("id") == pid for m in _workspace(owner, bot)["messages"] if m.get("page"))


def test_malicious_source_is_only_data_and_renderer_route_is_locked_down(bot_factory):
    owner = login()
    bot = bot_factory(owner, "PageSecurity" + uuid.uuid4().hex[:5])
    page = _create(owner, bot, MALICIOUS)
    status, stored = owner.call("GET", f"/api/pages/{page['id']}")
    assert status == 200 and stored["source"] == MALICIOUS
    with urllib.request.urlopen(BASE + "/page-renderer", timeout=15) as response:
        csp = response.headers["Content-Security-Policy"]
        for directive in ("default-src 'none'", "connect-src 'none'", "form-action 'none'", "frame-ancestors 'self'", "sandbox allow-scripts", "base-uri 'none'", "img-src data: blob:"):
            assert directive in csp
        assert "'unsafe-inline'" not in csp and "'unsafe-eval'" not in csp and "allow-same-origin" not in csp
        assert "script-src 'nonce-" in csp
        assert response.headers["Referrer-Policy"] == "no-referrer"
        assert response.headers.get("Set-Cookie") is None
        html = response.read().decode()
        assert "Quarterly report" not in html and MALICIOUS not in html
        assert "event.source !== parent" in html and "event.origin !== window.location.origin" in html
