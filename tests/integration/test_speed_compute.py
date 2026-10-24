"""Phase 3: isolated mock-stack readiness timings. Orchestrator only; no firewall changes."""
import json
import os
import subprocess
import time
import uuid

import pytest

from stack import COMPUTER_STACK_FILTER, computer_container
from test_acceptance import Client, login

pytestmark = pytest.mark.skipif(os.environ.get("LLM_PROVIDER") != "mock", reason="requires an isolated mock stack")


def _docker(*args):
    return subprocess.run(["sudo", "docker", *args], check=True, capture_output=True, text=True, timeout=15).stdout.strip()


def _pool_ids():
    return set(_docker("ps", "-a", "--filter", COMPUTER_STACK_FILTER,
                       "--filter", "label=teammates.warm_pool=template", "--format", "{{.ID}}").split())


def _wait(predicate, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(.05)
    raise AssertionError("computer readiness condition timed out")


def _cdp_ready(container):
    # CDP is internal to this fixture computer. No credential or host port is involved.
    probe = "import json,urllib.request; r=urllib.request.urlopen('http://127.0.0.1:9222/json/version',timeout=.3); assert json.load(r).get('webSocketDebuggerUrl')"
    result = subprocess.run(["sudo", "docker", "exec", container, "python3", "-c", probe], capture_output=True, timeout=2)
    return result.returncode == 0


def _percentile(values, p):
    ordered = sorted(values)
    at = (len(ordered) - 1) * p
    lo = int(at)
    return ordered[lo] + (ordered[min(lo + 1, len(ordered) - 1)] - ordered[lo]) * (at - lo)


@pytest.fixture
def speed_owner():
    staff = login()
    tag = uuid.uuid4().hex[:12]
    status, invite = staff.call("POST", "/api/invitations", {"email": f"speed-compute-{tag}@example.test", "role": "member"})
    assert status == 200
    client = Client()
    status, account = client.call("POST", "/api/invitations/accept", {
        "token": invite["token"], "username": f"speed-compute-{tag}", "password": "speed-compute-fixture-only",
    }, auth=False)
    assert status == 200
    try:
        yield client, staff
    finally:
        # bot_factory tears down its bots/computer first (fixture dependency order).
        staff.call("PATCH", f"/api/admin/users/{account['id']}", {"status": "disabled"})


def test_paused_composer_wake_p95_under_two_seconds_over_five_cycles(speed_owner, bot_factory):
    client, staff = speed_owner
    bot = bot_factory(client, "Wake speed " + uuid.uuid4().hex[:6])
    status, computer = client.call("GET", "/api/computer")
    assert status == 200 and computer.get("computerId")
    container = computer_container(computer["computerId"])
    samples = []
    last_request = float("-inf")
    try:
        for _ in range(5):
            # The public rate limit is part of the test; do not bypass it with hooks.
            while time.monotonic() - last_request < 30.1:
                time.sleep(.1)
            _docker("pause", container)
            last_request = time.monotonic()
            status, _ = client.call("POST", f"/api/bots/{bot}/computer/prewarm")
            assert status == 202
            _wait(lambda: _docker("inspect", "-f", "{{.State.Paused}}", container) == "false", timeout=3)
            _wait(lambda: _cdp_ready(container), timeout=3)
            samples.append((time.monotonic() - last_request) * 1000)
            assert client.call("POST", f"/api/bots/{bot}/computer/prewarm")[0] == 429
    finally:
        if _docker("inspect", "-f", "{{.State.Paused}}", container) == "true":
            _docker("unpause", container)
    report = {"wake_paused_ms": samples, "p50_ms": _percentile(samples, .5), "p95_ms": _percentile(samples, .95)}
    print(json.dumps(report))
    assert report["p95_ms"] < 2000, report
    # The normal Phase 0 dashboard must expose persisted compute samples.
    def recorded():
        status, speed = staff.call("GET", "/api/admin/speed")
        return status == 200 and next(m for m in speed["metrics"] if m["key"] == "wake_paused_ms")["count"] >= 5
    _wait(recorded)


def test_pool_claim_ready_under_five_seconds_and_refill_is_a_new_template(speed_owner, bot_factory):
    client, staff = speed_owner
    before = _wait(_pool_ids)
    started = time.monotonic()
    bot = bot_factory(client, "Pool speed " + uuid.uuid4().hex[:6])
    status, computer = client.call("GET", "/api/computer")
    assert status == 200 and computer.get("computerId")
    container = computer_container(computer["computerId"])
    _wait(lambda: _cdp_ready(container), timeout=5)
    ready_ms = (time.monotonic() - started) * 1000
    print(json.dumps({"warm_pool_ready_ms": ready_ms}))
    assert ready_ms < 5000
    after = _wait(lambda: ids if (ids := _pool_ids()) and ids.isdisjoint(before) else None)
    assert before.isdisjoint(after)
    labels = json.loads(_docker("inspect", "-f", "{{json .Config.Labels}}", container))
    assert "teammates.warm_pool" not in labels
    for template in after:
        labels = json.loads(_docker("inspect", "-f", "{{json .Config.Labels}}", template))
        assert labels["teammates.managed"] == "1"
        assert "teammates.owner_id" not in labels and "teammates.computer_id" not in labels
    def recorded():
        status, speed = staff.call("GET", "/api/admin/speed")
        return status == 200 and next(m for m in speed["metrics"] if m["key"] == "warm_pool_ready_ms")["count"] > 0
    _wait(recorded)


def test_prewarm_rejects_other_owner_and_anonymous(speed_owner, bot_factory):
    client, other_owner = speed_owner
    bot = bot_factory(client, "Private wake " + uuid.uuid4().hex[:6])
    assert other_owner.call("POST", f"/api/bots/{bot}/computer/prewarm")[0] == 403
    assert Client().call("POST", f"/api/bots/{bot}/computer/prewarm", auth=False)[0] == 401
    assert client.call("POST", f"/api/bots/{bot}/computer/prewarm", headers={"Origin": "https://invalid.example", "Sec-Fetch-Site": "cross-site"})[0] == 403
