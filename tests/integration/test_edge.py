"""Public Caddy does not publish /internal or /metrics. Tests call the API directly."""
import json
import os
import urllib.error
import urllib.request
import uuid

from stack import BASE
from stack import API
WORKER = os.environ.get("WORKER_TOKEN", "dev-worker-token-change-me")
METRICS = os.environ.get("METRICS_TOKEN", "dev-metrics-token-change-me")
OWNER = os.environ.get("OWNER_USERNAME", "saad")
PASSWORD = os.environ.get("OWNER_PASSWORD", "teammates-dev")


def call(base, method, path, body=None, headers=None, timeout=20):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(base + path, data=data, method=method)
    request.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8", "replace")
            return response.status, raw
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")


def test_public_proxy_hides_internal_and_metrics():
    status, body = call(BASE, "GET", "/metrics")
    assert "teammates_model_calls_total" not in body
    assert status != 200 or "text/html" in body.lower() or "<" in body
    status, body = call(BASE, "POST", "/internal/test/users", {"username": "edge-probe", "password": "edge-probe"})
    assert status in {404, 405, 401}
    assert "edge-probe" not in body or status == 404


def test_direct_api_serves_metrics_with_the_token():
    status, body = call(API, "GET", "/metrics")
    assert status == 401
    status, body = call(API, "GET", "/metrics", headers={"Authorization": "Bearer " + METRICS})
    assert status == 200
    assert "teammates_model_calls_total" in body


def test_audit_chain_hook_is_on_the_api_only():
    status, body = call(BASE, "GET", "/internal/test/audit-chain", headers={"Authorization": "Bearer " + WORKER})
    assert "teammates_model_calls_total" not in body
    assert status in {404, 405, 401}
    status, body = call(API, "GET", "/internal/test/audit-chain", headers={"Authorization": "Bearer " + WORKER})
    assert status == 200, body
    parsed = json.loads(body)
    assert parsed["ok"] is True


def test_login_rate_limit_and_policy_roundtrip():
    # A fresh documentation-range address makes strict limiter checks repeatable
    # without clearing another test's events on the shared isolated stack.
    suffix = uuid.uuid4().hex[:16]
    forwarded = {"X-Forwarded-For": "2001:db8::" + ":".join(suffix[i:i + 4] for i in range(0, 16, 4))}
    for _ in range(8):
        status, _ = call(API, "POST", "/api/auth/login", {"username": "nobody-edge", "password": "nope"}, forwarded)
        assert status == 401
    status, _ = call(API, "POST", "/api/auth/login", {"username": "nobody-edge", "password": "nope"}, forwarded)
    assert status == 429

    status, body = call(
        API,
        "POST",
        "/api/auth/login",
        {"username": OWNER, "password": PASSWORD},
        {"X-Forwarded-For": "203.0.113.78"},
    )
    assert status == 200, body
    # Cookie is on the raw response; log in through a tiny opener.
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor())
    request = urllib.request.Request(
        API + "/api/auth/login",
        data=json.dumps({"username": OWNER, "password": PASSWORD}).encode(),
        method="POST",
        headers={"Content-Type": "application/json", "X-Forwarded-For": "203.0.113.79"},
    )
    with opener.open(request, timeout=20) as response:
        assert response.status == 200

    def authed(method, path, payload=None):
        data = None if payload is None else json.dumps(payload).encode()
        req = urllib.request.Request(API + path, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        req.add_header("X-Forwarded-For", "203.0.113.79")
        try:
            with opener.open(req, timeout=20) as response:
                return response.status, response.read().decode()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read().decode("utf-8", "replace")

    status, body = authed("PUT", "/api/policy", {"classes": {"external_post": "ASK"}, "modelAssist": False})
    assert status == 200, body
    status, body = authed("GET", "/api/policy")
    parsed = json.loads(body)
    assert parsed["classes"]["external_post"] == "ASK"
    assert parsed["classes"]["read"] == "ALLOW"
    status, body = authed("GET", "/api/admin/policy/deny-list")
    assert status == 200
    assert "move_money" in body
    assert "Approval cannot override" in body
    status, body = authed("DELETE", "/api/admin/policy/deny-list/move_money")
    assert status == 403
    assert "builtin" in body

    canary = "CanaryLoginPassword9911"
    status, body = authed(
        "POST",
        "/api/login-requests/11111111-1111-1111-1111-111111111111",
        {"values": {"password": canary}, "saveToVault": False},
    )
    assert status == 404
    assert canary not in body

    other = call(
        API,
        "POST",
        "/internal/test/users",
        {"username": "edge-member", "password": "edge-member-secret"},
        {"Authorization": "Bearer " + WORKER},
    )
    assert other[0] == 200, other[1]
    member = urllib.request.build_opener(urllib.request.HTTPCookieProcessor())
    login = urllib.request.Request(
        API + "/api/auth/login",
        data=json.dumps({"username": "edge-member", "password": "edge-member-secret"}).encode(),
        method="POST",
        headers={"Content-Type": "application/json", "X-Forwarded-For": "203.0.113.80"},
    )
    with member.open(login, timeout=20) as response:
        assert response.status == 200
    req = urllib.request.Request(API + "/api/admin/policy/deny-list", method="GET")
    req.add_header("X-Forwarded-For", "203.0.113.80")
    try:
        with member.open(req, timeout=20) as response:
            status, body = response.status, response.read().decode()
    except urllib.error.HTTPError as exc:
        status, body = exc.code, exc.read().decode("utf-8", "replace")
    assert status == 403
