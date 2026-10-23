"""Library indexing and paging on the live mock stack."""
import uuid

from test_acceptance import Client, login, worker_call
from test_bot_messaging import _bot, _cleanup, _workspace


def test_uploaded_chat_attachments_are_grouped_and_paged_per_group():
    client = login()
    bot = _bot(client, "Library" + uuid.uuid4().hex[:6])
    try:
        conversation = _workspace(client, bot)["conversationId"]
        for index in range(12):
            name = f"library-{uuid.uuid4().hex[:7]}-{index}.txt"
            path = f"/workspace/uploads/{name}"
            status, _ = client.call("PUT", f"/api/bots/{bot}/files", raw=f"attachment {index}".encode(), headers={"x-path": path, "Content-Type": "application/octet-stream"})
            assert status == 200
            status, posted = client.call("POST", f"/api/conversations/{conversation}/messages", {"content": f"[attached: {path}]", "asTask": False})
            assert status == 200, posted
        status, first = client.call("GET", f"/api/bots/{bot}/library?limit=5")
        assert status == 200, first
        today = next(group for group in first["groups"] if group["key"] == "today")
        assert today["total"] == 12 and len(today["items"]) == 5 and today["nextCursor"]
        names = {row["name"] for row in today["items"]}
        cursor = today["nextCursor"]
        while cursor:
            status, page = client.call("GET", f"/api/bots/{bot}/library?group=today&limit=5&cursor={cursor}")
            assert status == 200, page
            next_group = page["groups"][0]
            names.update(row["name"] for row in next_group["items"])
            cursor = next_group["nextCursor"]
        assert len(names) == 12
        assert client.call("GET", f"/api/bots/{uuid.uuid4()}/library")[0] == 404
        other = Client()
        assert other.call("POST", "/api/auth/login", {"username": "library-other", "password": "library-other-password"}, auth=False)[0] in (401, 200)
        if not other.cookie:
            worker_call("POST", "/internal/test/users", {"username": "library-other", "password": "library-other-password"})
            assert other.call("POST", "/api/auth/login", {"username": "library-other", "password": "library-other-password"}, auth=False)[0] == 200
        assert other.call("GET", f"/api/bots/{bot}/library")[0] == 404
    finally:
        _cleanup(client, bot)


def test_screenshot_items_are_hidden_from_all_group_listing():
    client = login()
    bot = _bot(client, "LibraryShot" + uuid.uuid4().hex[:5])
    try:
        # Insert only an index row: this verifies the visibility rule without reaching a desktop or writing a blob.
        name = "test-screen.png"
        digest = uuid.uuid4().hex * 2
        from test_acceptance import _psql
        _psql("INSERT INTO library_items(bot_id,source,direction,name,ext,mime,kind,size_bytes,sha256) "
              f"VALUES('{bot}','screenshot','out','{name}','png','image/png','screenshots',1,'{digest}')")
        status, result = client.call("GET", f"/api/bots/{bot}/library")
        assert status == 200, result
        assert all(row["name"] != name for group in result["groups"] for row in group["items"])
    finally:
        _cleanup(client, bot)
