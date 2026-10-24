"""Skills v2 owner privacy, revision and DLP acceptance coverage (mock stack)."""
import uuid
import pytest
from test_acceptance import _psql, login
from test_acceptance import worker_call
from test_bot_messaging import _bot, _cleanup, _workspace


def _skill_task(client, bot, args):
    conversation = _workspace(client, bot)["conversationId"]
    task = _psql(
        "INSERT INTO tasks (bot_id,conversation_id,title,instruction,kind,status,lease_owner,lease_until,lease_epoch) "
        f"VALUES ('{bot}','{conversation}','Skill test','Save a reusable guide','work','running','skill-test',now()+interval '1 hour',1) RETURNING id"
    ).splitlines()[0]
    return {"taskId": task, "botId": bot, "epoch": 1, "tool": "write_skill", "args": args, "idempotencyKey": "skill-" + uuid.uuid4().hex}


def test_owner_skill_crud_revision_and_sensitive_body_rejection():
    client = login()
    bot = _bot(client, "Skills" + uuid.uuid4().hex[:5])
    try:
        payload = {"name":"review-orders", "title":"Review orders", "whenToUse":"When checking the queue", "body":"# Review\nCheck the queue."}
        status, created = client.call("POST", f"/api/bots/{bot}/skill-library", payload)
        assert status == 200, created
        sid = created["id"]
        assert client.call("GET", f"/api/skill-library/{sid}")[1]["body"] == payload["body"]
        changed = dict(payload, body="# Review v2\nCheck carefully.")
        assert client.call("PUT", f"/api/skill-library/{sid}", changed)[0] == 200
        revisions = client.call("GET", f"/api/skill-library/{sid}/revisions")[1]
        assert revisions[0]["version"] == 1 and revisions[0]["body"] == payload["body"]
        assert revisions[-1]["version"] == 0 and revisions[-1]["body"] == ""
        assert client.call("POST", f"/api/skill-library/{sid}/revert/1")[0] == 200
        assert client.call("GET", f"/api/skill-library/{sid}")[1]["body"] == payload["body"]
        assert int(_psql(f"SELECT count(*) FROM audit_events WHERE action LIKE 'skill.%' AND detail::text LIKE '%{sid}%'") or "0") >= 3
        assert client.call("POST", f"/api/bots/{bot}/skill-library", dict(payload, name="bad", body="api_key=sk_live_12345678901234567890"))[0] == 400
        other = _bot(client, "Other" + uuid.uuid4().hex[:5])
        try:
            private = dict(payload, name="private-guide", botId=bot)
            private_status, private_result = client.call("POST", f"/api/bots/{bot}/skill-library", private)
            assert private_status == 200
            assert private_result["id"] not in {row["id"] for row in client.call("GET", f"/api/bots/{other}/skill-library")[1]}
            assert worker_call("GET", f"/internal/skills/{bot}/private-guide")["name"] == "private-guide"
            with pytest.raises(AssertionError, match="404"):
                worker_call("GET", f"/internal/skills/{other}/private-guide")
        finally:
            _cleanup(client, other)
        assert client.call("POST", f"/api/skill-library/{sid}/archive")[0] == 200
        assert client.call("GET", f"/api/skill-library/{sid}")[0] == 404
    finally:
        _cleanup(client, bot)


def test_bot_edit_permission_defaults_off_and_owner_can_enable_it():
    client = login()
    bot = _bot(client, "SkillPerm" + uuid.uuid4().hex[:5])
    try:
        payload = {"name":"owner-guide", "title":"Owner guide", "whenToUse":"When working", "body":"# Owner guide", "botId":bot}
        status, created = client.call("POST", f"/api/bots/{bot}/skill-library", payload)
        assert status == 200, created
        write = {"name":"owner-guide", "title":"Updated guide", "when_to_use":"When working", "body":"# Updated"}
        # A worker token and a bare guide body cannot bypass policy/lease checks.
        with pytest.raises(AssertionError, match="400"):
            worker_call("POST", f"/internal/skills/{bot}/write", write)
        sid = created["id"]
        assert created["version"] == 1
        status, revisions_before = client.call("GET", f"/api/skill-library/{sid}/revisions")
        assert status == 200
        envelope = _skill_task(client, bot, write)
        denied = worker_call("POST", f"/internal/skills/{bot}/write", envelope)
        assert denied["ok"] is False and denied["status"] == "denied"
        status, unchanged = client.call("GET", f"/api/skill-library/{sid}")
        assert status == 200 and unchanged["version"] == 1
        assert unchanged["body"] == payload["body"] and unchanged["allow_bot_edit"] is False
        assert client.call("GET", f"/api/skill-library/{sid}/revisions") == (200, revisions_before)
        assert _psql(f"SELECT count(*) FROM audit_events WHERE action='skill.bot_write' AND detail::text LIKE '%{sid}%'") == "0"
        status, updated = client.call("PUT", f"/api/skill-library/{sid}", dict(payload, allowBotEdit=True))
        assert status == 200 and updated["version"] == 2
        result = worker_call("POST", f"/internal/skills/{bot}/write", envelope)
        assert result["output"]["version"] == 3
        replay = worker_call("POST", f"/internal/skills/{bot}/write", envelope)
        assert replay["deduped"] is True and replay["output"] == result["output"]
        assert _psql(f"SELECT count(*) FROM skill_revisions WHERE skill_id='{created['id']}' AND author='{bot}' AND reason='bot update'") == "1"
        assert int(_psql(f"SELECT count(*) FROM audit_events WHERE action='skill.bot_write' AND detail::text LIKE '%{created['id']}%'") or "0") == 1
    finally:
        _cleanup(client, bot)


def test_bot_private_guide_wins_over_shared_guide_for_load_and_write():
    client = login()
    bot = _bot(client, "SkillScope" + uuid.uuid4().hex[:5])
    shared_id = None
    try:
        name = "scope-" + uuid.uuid4().hex[:8]
        shared = {"name": name, "title": "Shared", "whenToUse": "When reviewing", "body": "Shared guide"}
        status, created = client.call("POST", f"/api/bots/{bot}/skill-library", shared)
        assert status == 200, created
        shared_id = created["id"]
        private = dict(shared, botId=bot, title="Private", body="Private guide", allowBotEdit=True)
        status, created = client.call("POST", f"/api/bots/{bot}/skill-library", private)
        assert status == 200, created
        private_id = created["id"]
        loaded = worker_call("GET", f"/internal/skills/{bot}/{name}")
        assert loaded["body"] == "Private guide"
        catalog = worker_call("GET", f"/internal/skills/{bot}/catalog")["catalog"]
        assert len([line for line in catalog if line.startswith(name + ":")]) == 1
        envelope = _skill_task(client, bot, {"name": name, "title": "Updated", "when_to_use": "When reviewing", "body": "Private update"})
        result = worker_call("POST", "/internal/tools/execute", envelope)
        assert result["ok"] is True and result["output"]["id"] == private_id
        assert client.call("GET", f"/api/skill-library/{shared_id}")[1]["body"] == "Shared guide"
        with pytest.raises(AssertionError, match="409"):
            worker_call("POST", "/internal/tools/execute", dict(envelope, epoch=0))
        other = _bot(client, "ScopeOther" + uuid.uuid4().hex[:5])
        try:
            for endpoint in ("authorize", "preexec", "execute"):
                with pytest.raises(AssertionError, match="409"):
                    worker_call("POST", f"/internal/tools/{endpoint}", dict(envelope, botId=other))
        finally:
            _cleanup(client, other)
    finally:
        if shared_id:
            client.call("POST", f"/api/skill-library/{shared_id}/archive")
        _cleanup(client, bot)


def test_direct_skill_write_honors_owner_deny_and_ask_policy():
    client = login()
    bot = _bot(client, "SkillPolicy" + uuid.uuid4().hex[:5])
    status, original = client.call("GET", "/api/policy")
    assert status == 200
    try:
        for mode in ("deny", "ask"):
            policy = dict(original, classes=dict(original["classes"], write=mode))
            assert client.call("PUT", "/api/policy", policy)[0] == 200
            name = "policy-" + uuid.uuid4().hex[:8]
            envelope = _skill_task(client, bot, {"name": name, "title": "Policy guide", "when_to_use": "When working", "body": "Safe guide"})
            # Test the compatibility endpoint directly, without worker preauthorization.
            result = worker_call("POST", f"/internal/skills/{bot}/write", envelope)
            assert result["ok"] is False
            assert result["status"] == ("denied" if mode == "deny" else "waiting_approval")
            assert _psql(f"SELECT count(*) FROM skill_library WHERE bot_id='{bot}' AND name='{name}'") == "0"
            action = "tool.denied" if mode == "deny" else "approval.required"
            assert int(_psql(f"SELECT count(*) FROM audit_events WHERE task_id='{envelope['taskId']}' AND action='{action}'") or "0") >= 1
    finally:
        assert client.call("PUT", "/api/policy", original)[0] == 200
        _cleanup(client, bot)
