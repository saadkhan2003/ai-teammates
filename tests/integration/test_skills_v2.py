"""Skills v2 owner privacy, revision and DLP acceptance coverage (mock stack)."""
import uuid
from test_acceptance import login
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
        assert client.call("GET", f"/api/skill-library/{sid}/revisions")[1][0]["version"] == 1
        assert client.call("POST", f"/api/bots/{bot}/skill-library", dict(payload, name="bad", body="api_key=sk_live_12345678901234567890"))[0] == 400
    finally:
        _cleanup(client, bot)
