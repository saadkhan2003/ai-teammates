"""Run only on an isolated mock stack. Admin writes are restored in fixture teardown."""
import json
import subprocess
import time
import uuid

import pytest

from stack import MOCK_CONTAINER, worker_request
from test_acceptance import Client, login, submit, auto_allow_browser_opens, _read_sse
from test_bot_messaging import _workspace
import threading


def calls():
    # The mock counter is intentionally reachable only inside this isolated compose network.
    script = "import json,urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8090/__calls',timeout=5).read().decode())"
    return json.loads(subprocess.check_output(["sudo", "docker", "exec", MOCK_CONTAINER, "python3", "-c", script], text=True, timeout=15))


def request(client, method, path, body=None, expected=200):
    activate = method == "PUT" and path == "/config" and expected == 200 and not body.get("as_candidate", False)
    if activate:
        body = {**body, "as_candidate": True}
    status, value = client.call(method, "/api/admin/ai" + path, body)
    # Never include response bodies from key writes in assertion diagnostics.
    assert status == expected, f"{method} {path}: HTTP {status}, expected {expected}"
    if activate:
        version = value["version"]
        request(client, "POST", f"/versions/{version}/eval")
        request(client, "POST", f"/versions/{version}/publish", {"override_reason": "Explicit isolated fixture bootstrap or switch approval"})
    return value


@pytest.fixture
def registry():
    owner = login()
    original = request(owner, "GET", "")
    providers = []
    for label, base, kind in [("A", "/api/v1", "mock"), ("B", "/p2/v1", "openai_compatible"), ("Native", "/anthropic", "anthropic")]:
        provider = request(owner, "POST", "/providers", {"name": f"ai-test-{label}-{uuid.uuid4().hex[:8]}", "kind": kind, "base_url": "http://mock-openrouter:8090" + base, "enabled": True, "models": [{"id": "mock/planner", "label": "Mock planner", "tools": True, "vision": True, "context_tokens": 128000}]})
        request(owner, "PUT", f"/providers/{provider['id']}/key", {"key": "sk-or-test-only-ai-models-0000"}, expected=204)
        providers.append(provider["id"])
    def config(provider):
        return {"roles": {"chat": {"primary": {"provider": provider, "model": "mock/planner"}, "fallbacks": []}}, "caching": {"enabled": True, "anthropic_cache_control": True, "session_id_per_conversation": True, "ttl": "5m"}, "rollout": {"candidate_version": None, "percent": 0}}
    initial = request(owner, "PUT", "/config", {"config": config(providers[0]), "note": "AI integration A"})["version"]
    try:
        yield owner, providers, config, initial
    finally:
        # The first installed config replaces bootstrap; keep a mock config on test-only stacks.
        if original["version"]:
            request(owner, "POST", f"/versions/{original['version']}/rollback")
        else:
            request(owner, "POST", f"/versions/{initial}/rollback")
        for provider in providers:
            status, _ = owner.call("DELETE", f"/api/admin/ai/providers/{provider}")
            assert status in (200, 400)  # A is retained if the isolated stack originally used env bootstrap.


def test_admin_crud_guard_write_only_keys_and_probe(registry):
    owner, providers, config, initial = registry
    metadata = request(owner, "GET", "")
    serialized = json.dumps(metadata)
    assert "sk-or-test-only-ai-models-0000" not in serialized
    assert "ciphertext" not in serialized and "nonce" not in serialized
    assert all(p["key_set"] for p in metadata["providers"] if p["id"] in providers)
    for provider in providers:
        result = request(owner, "POST", f"/providers/{provider}/test")
        assert result["ok"] and result["latency_ms"] >= 0
    request(owner, "DELETE", f"/providers/{providers[0]}", expected=400)
    request(owner, "PUT", "/config", {"config": {"roles": {}}}, expected=400)
    status, invite = owner.call("POST", "/api/invitations", {"email": f"ai-{uuid.uuid4().hex}@example.test", "role": "member"})
    assert status == 200
    member = Client()
    status, _ = member.call("POST", "/api/invitations/accept", {"token": invite["token"], "username": "ai-member-" + uuid.uuid4().hex[:8], "password": "mock-test-member-only"}, auth=False)
    assert status == 200
    for method, path, body in [("GET", "", None), ("GET", "/versions", None), ("GET", "/audit", None), ("POST", f"/providers/{providers[0]}/test", None), ("PUT", f"/providers/{providers[0]}/key", {"key": "test-only"}), ("PUT", "/config", {"config": config(providers[0])}), ("PUT", "/rollout", {"candidate_version": None, "percent": 0}), ("POST", f"/versions/{initial}/rollback", None)]:
        request(member, method, path, body, expected=403)
    for endpoint in ["/api/bots", "/api/usage", "/api/system/llm-status", "/api/model-requests"]:
        status, data = owner.call("GET", endpoint)
        assert status == 200
        assert not any(f'"{key}"' in json.dumps(data) for key in ("model", "provider", "llmProvider"))


def test_mid_run_switch_rollback_and_rollout(registry, bot_factory):
    owner, providers, config, initial = registry
    bot = bot_factory(owner, "AI runtime switch " + uuid.uuid4().hex[:6])
    conversation = _workspace(owner, bot)["conversationId"]
    before = calls()
    task = submit(owner, conversation, "LONG RUN DEMO 4 SLOW")
    stop = threading.Event()
    approver = auto_allow_browser_opens(bot, stop)
    try:
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            if calls().get("/api/v1/chat/completions", 0) > before.get("/api/v1/chat/completions", 0):
                break
            time.sleep(0.1)
        else:
            pytest.fail("task did not start on provider A")
        switched = request(owner, "PUT", "/config", {"config": config(providers[1]), "note": "Switch running task to B"})["version"]
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            workspace = _workspace(owner, bot)
            row = next(item for item in workspace["tasks"] if item["id"] == task)
            if row["status"] in ("completed", "failed", "error", "cancelled"):
                assert row["status"] == "completed", row["status"]
                break
            time.sleep(0.25)
        else:
            pytest.fail("runtime-switch task did not complete")
        assert calls().get("/p2/v1/chat/completions", 0) > before.get("/p2/v1/chat/completions", 0)
        model_calls = request(owner, "GET", "/calls")
        assert any(row.get("taskId") == task and row.get("configVersion") == switched and row.get("providerId") == providers[1] for row in model_calls), "task rounds (not evals) must hit B"
        restored = request(owner, "POST", f"/versions/{initial}/rollback")
        assert restored["version"] == initial
        # A model round on the same task now uses the newly active rollback version.
        a_before = calls().get("/api/v1/chat/completions", 0)
        status, reply = worker_request("POST", "/internal/model/complete", {"botId": bot, "taskId": task, "messages": [{"role": "user", "content": "What should I call you?"}]})
        assert status == 200 and reply["status"] == "ok"
        assert calls().get("/api/v1/chat/completions", 0) > a_before
        candidate = request(owner, "PUT", "/config", {"config": config(providers[1]), "note": "Candidate B", "as_candidate": True})["version"]
        for percent, path in [(0, "/api/v1/chat/completions"), (100, "/p2/v1/chat/completions")]:
            request(owner, "PUT", "/rollout", {"candidate_version": candidate, "percent": percent, "override_reason": "Explicit isolated rollout fixture approval"})
            previous = calls().get(path, 0)
            # New task per cohort: a task stays pinned while the active version is unchanged.
            cohort = submit(owner, conversation, "What should I call you?")
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline and calls().get(path, 0) <= previous:
                time.sleep(0.1)
            assert calls().get(path, 0) > previous
            assert cohort
    finally:
        stop.set()
        approver.join(3)


def test_catalog_sync_alert_served_model_and_eval_gate(registry):
    owner, providers, config, initial = registry
    request(owner, "POST", "/catalog/sync")
    catalog = request(owner, "GET", "/catalog")
    assert any(row["metadata"].get("expiration_date") for row in catalog)
    retiring = config(providers[0])
    retiring["roles"]["chat"]["primary"]["model"] = "mock/retiring"
    candidate = request(owner, "PUT", "/config", {"config": retiring, "as_candidate": True})["version"]
    assert any(a["model"] == "mock/retiring" and a["reason"] == "scheduled_expiration" for a in request(owner, "GET", "/alerts"))
    weak = config(providers[0]); weak["roles"]["chat"]["primary"]["model"] = "mock/weak"
    candidate = request(owner, "PUT", "/config", {"config": weak, "as_candidate": True})["version"]
    evaluated = request(owner, "POST", f"/versions/{candidate}/eval")
    assert not evaluated["passed"] and not evaluated["hard_pass"]
    request(owner, "POST", f"/versions/{candidate}/publish", {}, expected=400)
    request(owner, "POST", f"/versions/{candidate}/rollback", expected=400)
    request(owner, "POST", f"/versions/{candidate}/publish", {"override_reason": "Owner accepts known weak mock fixture for gate test"})
    log = request(owner, "GET", "/audit")
    assert any(row["action"] == "eval.owner_override" for row in log)
    request(owner, "POST", f"/versions/{initial}/rollback")
    candidate = request(owner, "PUT", "/config", {"config": config(providers[1]), "as_candidate": True})["version"]
    good = request(owner, "POST", f"/versions/{candidate}/eval")
    assert good["passed"]
    request(owner, "POST", f"/versions/{candidate}/publish", {})


def test_kill_switch_spend_cap_user_payloads_and_sse_have_no_model_branding(registry, bot_factory):
    owner, providers, config, initial = registry
    bot = bot_factory(owner, "Controls privacy " + uuid.uuid4().hex[:6])
    conversation = _workspace(owner, bot)["conversationId"]
    task = submit(owner, conversation, "What should I call you?")
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        row = next(t for t in _workspace(owner, bot)["tasks"] if t["id"] == task)
        if row["status"] == "completed":
            break
        time.sleep(0.2)
    else:
        pytest.fail("initial privacy fixture task did not complete")
    forbidden = ["openrouter", "anthropic", "openai", "gemini", "claude", "gpt-", "deepseek", "groq", "llama", "mistral", "grok", "mock/planner", "mock/retiring", "mock/weak"]
    def clean(value):
        text = json.dumps(value).lower()
        assert not any(word in text for word in forbidden), "user-facing payload contains model/provider branding"
    events, errors = [], []
    stop, ready = threading.Event(), threading.Event()
    reader = threading.Thread(target=_read_sse, args=(owner.cookie, events, stop, ready, errors), daemon=True)
    reader.start()
    assert ready.wait(10), "SSE subscription failed"
    body = {"botId": bot, "taskId": task, "messages": [{"role": "user", "content": "What should I call you?"}]}
    try:
        request(owner, "PUT", "/kill-switch", {"mode": "stop"})
        waiting = submit(owner, conversation, "What should I call you?")
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            row = next(t for t in _workspace(owner, bot)["tasks"] if t["id"] == waiting)
            if row["status"] == "waiting_resource":
                break
            time.sleep(0.2)
        else:
            pytest.fail("kill switch did not pause the worker cleanly")
        before = calls()
        status, paused = worker_request("POST", "/internal/model/complete", body)
        assert status == 200 and paused["status"] == "waiting_resource"
        clean(paused)
        assert calls() == before, "kill switch must not contact a provider"
        request(owner, "PUT", "/kill-switch", {"mode": "safe", "safe_model": {"provider": providers[1], "model": "mock/planner"}})
        status, answer = worker_request("POST", "/internal/model/complete", body)
        assert status == 200 and answer["status"] == "ok"
        clean(answer)
        rows = request(owner, "GET", "/calls")
        assert any(row.get("taskId") == task and row.get("servedModel") == "mock/planner" and row.get("providerId") == providers[1] for row in rows)
        request(owner, "PUT", "/kill-switch", {"mode": "off"})
        capped = config(providers[0]); capped["budgets"] = {"plans": {"default": {"daily": 0, "monthly": 0, "action": "block"}}}
        candidate = request(owner, "PUT", "/config", {"config": capped, "as_candidate": True})["version"]
        request(owner, "POST", f"/versions/{candidate}/publish", {"override_reason": "Explicit zero-spend fixture for enforcement test"})
        status, blocked = worker_request("POST", "/internal/model/complete", body)
        assert status == 200 and blocked["status"] == "waiting_resource"
        clean(blocked)
        for endpoint in ["/api/bots", f"/api/bots/{bot}/workspace", f"/api/bots/{bot}/tasks", "/api/usage", f"/api/bots/{bot}/messages"]:
            status, payload = owner.call("GET", endpoint)
            assert status == 200, f"GET {endpoint.split('/')[2]}…{endpoint.rsplit('/',1)[-1]}: HTTP {status}"
            clean(payload)
        time.sleep(0.5)
        assert events, "capture actual SSE payloads"
        for event in events:
            clean(event)
    finally:
        stop.set(); reader.join(6)
        request(owner, "PUT", "/kill-switch", {"mode": "off"})
        request(owner, "POST", f"/versions/{initial}/rollback")


def test_create_provider_ignores_blank_client_id(registry):
    # The admin form sends id:"" for a new provider; the server assigns the id.
    owner = registry[0]
    body = {"id": "", "name": f"ai-test-blank-{uuid.uuid4().hex[:8]}", "kind": "mock", "base_url": "http://mock-openrouter:8090/v1",
            "enabled": False, "models": [{"id": "mock/planner", "label": "", "context_tokens": 0, "tools": True, "vision": False, "caching": False}]}
    created = request(owner, "POST", "/providers", body)
    try:
        assert uuid.UUID(created["id"])
    finally:
        owner.call("DELETE", f"/api/admin/ai/providers/{created['id']}")
