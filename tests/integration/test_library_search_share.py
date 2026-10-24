"""Library search and share privacy across bots and users."""
import json
import urllib.error
import urllib.parse
import urllib.request
import uuid

from test_acceptance import Client, login, worker_call, _psql
from test_bot_messaging import _bot, _cleanup, _workspace
from stack import BASE


def _public(url):
    req = urllib.request.Request(url)
    try:
        return urllib.request.urlopen(req, timeout=30)
    except urllib.error.HTTPError as exc:
        return exc


def test_search_filters_and_share_expiry_revoke_and_owner_scope():
    owner = login()
    suffix = uuid.uuid4().hex[:8]
    first_bot = _bot(owner, "LibraryShare" + suffix)
    second_bot = _bot(owner, "LibraryOther" + suffix)
    other = Client()
    other_bot = None
    try:
        assert other.call("POST", "/api/auth/login", {"username": "library-share-other", "password": "library-share-other-password"}, auth=False)[0] in (401, 200)
        if not other.cookie:
            worker_call("POST", "/internal/test/users", {"username": "library-share-other", "password": "library-share-other-password"})
            assert other.call("POST", "/api/auth/login", {"username": "library-share-other", "password": "library-share-other-password"}, auth=False)[0] == 200
        other_bot = _bot(other, "LibraryPrivate" + suffix)

        name = "needle-" + suffix + ".txt"
        path = "/workspace/uploads/" + name
        workspace = _workspace(owner, first_bot)
        conversation = workspace["conversationId"]
        assert owner.call("PUT", f"/api/bots/{first_bot}/files", raw=b"searchable library content", headers={"x-path": path, "Content-Type": "application/octet-stream"})[0] == 200
        assert owner.call("POST", f"/api/conversations/{conversation}/messages", {"content": f"[attached: {path}]", "asTask": False})[0] == 200
        shot_name = "needle-shot-" + suffix + ".png"
        digest = uuid.uuid4().hex * 2
        _psql(f"INSERT INTO library_items(bot_id,source,direction,name,ext,mime,kind,size_bytes,sha256) VALUES('{first_bot}','screenshot','out','{shot_name}','png','image/png','screenshots',1,'{digest}')")

        status, found = owner.call("GET", f"/api/bots/{first_bot}/library?q=needle-{suffix[:4]}&type=documents&direction=in")
        assert status == 200 and found["items"] and found["items"][0]["name"] == name
        assert owner.call("GET", f"/api/bots/{first_bot}/library?q=needle-{suffix[:4]}&type=pdfs")[1]["items"] == []
        status, screenshots = owner.call("GET", f"/api/bots/{first_bot}/library?q=needle-shot-{suffix[:4]}&type=screenshots")
        assert status == 200 and [row["name"] for row in screenshots["items"]] == [shot_name]
        assert owner.call("GET", f"/api/bots/{first_bot}/library?q=needle-shot-{suffix[:4]}&type=all")[1]["items"] == []
        assert owner.call("GET", f"/api/bots/{second_bot}/library?q=needle-{suffix[:4]}")[1]["items"] == []
        assert other.call("GET", f"/api/bots/{first_bot}/library?q=needle-{suffix[:4]}")[0] == 404
        assert other.call("GET", f"/api/bots/{other_bot}/library?q=needle-{suffix[:4]}")[1]["items"] == []

        item = found["items"][0]
        assert owner.call("POST", f"/api/bots/{first_bot}/library/{item['id']}/share", {"expiresInDays": 31})[0] == 400
        status, created = owner.call("POST", f"/api/bots/{first_bot}/library/{item['id']}/share", {"expiresInDays": 1})
        assert status == 200
        share_url = created["url"]
        token = share_url.rsplit("/", 1)[-1]
        assert len(token) == 64 and all(character in "0123456789abcdef" for character in token)
        base = BASE
        with _public(base + "/api/public/library/" + token) as response:
            assert response.status == 200
            assert response.headers["X-Robots-Tag"] == "noindex"
            metadata = json.loads(response.read())
            assert metadata["name"] == name
        with _public(base + "/api/public/library/" + token + "/content") as response:
            assert response.status == 200 and response.read() == b"searchable library content"
            assert response.headers["X-Content-Type-Options"] == "nosniff"
        ranged = urllib.request.Request(base + "/api/public/library/" + token + "/content", headers={"Range": "bytes=2-5"})
        with urllib.request.urlopen(ranged, timeout=30) as response:
            assert response.status == 206 and response.read() == b"arch"
        assert other.call("GET", f"/api/bots/{first_bot}/library/{item['id']}/share")[0] == 404

        status, listed = owner.call("GET", f"/api/bots/{first_bot}/library/{item['id']}/share")
        assert status == 200 and len(listed["shares"]) == 1
        share_id = listed["shares"][0]["id"]
        _psql(f"UPDATE library_shares SET expires_at=now()-interval '1 minute' WHERE id='{share_id}'")
        assert _public(base + "/api/public/library/" + token).status == 404

        status, created = owner.call("POST", f"/api/bots/{first_bot}/library/{item['id']}/share", {"expiresInDays": 7})
        assert status == 200
        next_token = created["url"].rsplit("/", 1)[-1]
        status, listed = owner.call("GET", f"/api/bots/{first_bot}/library/{item['id']}/share")
        live = next(share for share in listed["shares"] if not share["revokedAt"])
        assert owner.call("DELETE", f"/api/bots/{first_bot}/library/{item['id']}/share/{live['id']}")[0] == 200
        assert _public(base + "/api/public/library/" + next_token).status == 404
    finally:
        _cleanup(owner, first_bot)
        _cleanup(owner, second_bot)
        if other_bot:
            _cleanup(other, other_bot)
