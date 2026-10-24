"""Skills v2 owner privacy, revision and DLP acceptance coverage (mock stack)."""
import uuid
import pytest
from test_acceptance import _psql, login
from test_acceptance import worker_call
from test_bot_messaging import _bot, _cleanup


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
        with pytest.raises(AssertionError, match="403"):
            worker_call("POST", f"/internal/skills/{bot}/write", write)
        assert client.call("PUT", f"/api/skill-library/{created['id']}", dict(payload, allowBotEdit=True))[0] == 200
        result = worker_call("POST", f"/internal/skills/{bot}/write", write)
        assert result["version"] == 2
        assert _psql(f"SELECT count(*) FROM skill_revisions WHERE skill_id='{created['id']}' AND author='{bot}' AND reason='bot update'") == "1"
        assert int(_psql(f"SELECT count(*) FROM audit_events WHERE action='skill.bot_write' AND detail::text LIKE '%{created['id']}%'") or "0") == 1
    finally:
        _cleanup(client, bot)
