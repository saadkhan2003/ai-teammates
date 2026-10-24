"""Resource plan: plan limits in admin, storage quota (warn/full), object-storage sync, cleanup, shared image (mock LLM, isolated stack only)."""
import json
import os
import time
import uuid

import pytest

from test_acceptance import OPENROUTER, Client, _psql, approve, login, wait_task
from test_bot_messaging import _workspace

pytestmark = pytest.mark.skipif(os.environ.get("LLM_PROVIDER") != "mock", reason="requires an isolated mock stack")

PLAN = "itest-res"
GIB = 1024 ** 3


@pytest.fixture
def res_owner():
    staff = login()
    _psql(f"INSERT INTO billing_plans (id,name,price_usd,weekly_credits,on_demand_cap_usd,job_default_minutes,job_max_minutes,max_running_jobs,upgrade_to,sort,storage_quota_gb,storage_warn_pct) "
          f"VALUES ('{PLAN}','Test Resources',30,100000,50,5,10,2,'pro',98,1,80) ON CONFLICT (id) DO UPDATE SET weekly_credits=100000,storage_quota_gb=1,storage_warn_pct=80")
    tag = uuid.uuid4().hex[:10]
    status, invite = staff.call("POST", "/api/invitations", {"email": f"res-{tag}@example.test", "role": "member"})
    assert status == 200
    client = Client()
    status, account = client.call("POST", "/api/invitations/accept", {
        "token": invite["token"], "username": f"res-{tag}", "password": "resources-fixture-only-pass"}, auth=False)
    assert status == 200
    assert client.call("POST", "/api/secrets", {"namespace": "openrouter", "name": "default", "type": "API_KEY", "value": OPENROUTER})[0] == 200
    try:
        yield client, staff, account["id"]
    finally:
        _psql(f"DELETE FROM stored_files WHERE owner_id='{account['id']}' AND path='itest-big.bin'")
        staff.call("PUT", f"/api/admin/billing/plans/standard/assign/{account['id']}")
        staff.call("PATCH", f"/api/admin/users/{account['id']}", {"status": "disabled"})


def _send(client, bot, text):
    conversation = _workspace(client, bot)["conversationId"]
    status, sent = client.call("POST", f"/api/conversations/{conversation}/messages", {"content": text, "client_id": str(uuid.uuid4())})
    assert status == 200, sent
    deadline = time.time() + 120
    while time.time() < deadline:
        task = next(t for t in client.call("GET", f"/api/bots/{bot}/tasks")[1] if t["id"] == sent["taskId"])
        if task["status"] == "waiting_approval" and task.get("waitingReason") == "write_file":
            approve(client, bot, "write_file", "allow_always")  # the owner allows writes to this one notes file
        if task["status"] in {"completed", "failed", "cancelled"}:
            break
        time.sleep(1)
    task = wait_task(client, bot, sent["taskId"], timeout=5)
    messages = [str(m.get("content") or "") for m in _workspace(client, bot)["messages"]]
    return task, messages


def test_standard_plan_limits_show_on_usage_and_admin_validates_them(res_owner):
    client, staff, user_id = res_owner
    status, usage = client.call("GET", "/api/usage/credits")
    assert status == 200
    assert usage["limits"] == {"storageQuotaGb": 50, "ramMb": 8192, "cpuMinCores": 1, "cpuMaxCores": 2}
    assert usage["storage"]["quotaBytes"] == 50 * GIB and usage["storage"]["state"] == "ok" and usage["storage"]["warnPct"] == 80
    assert client.call("GET", "/api/admin/billing/resources")[0] in {401, 403}
    assert client.call("POST", "/api/admin/billing/cleanup/run")[0] in {401, 403}

    for bad in ({"storageQuotaGb": 0}, {"storageWarnPct": 101}, {"ramMb": 100}, {"cpuMinCores": 3, "cpuMaxCores": 2}):
        assert staff.call("PUT", f"/api/admin/billing/plans/{PLAN}", bad)[0] == 400, bad
    assert staff.call("PUT", f"/api/admin/billing/plans/{PLAN}", {"ramMb": 4096, "cpuMinCores": 1, "cpuMaxCores": 1.5, "storageQuotaGb": 1})[0] == 200
    plan = next(p for p in staff.call("GET", "/api/admin/billing")[1]["plans"] if p["id"] == PLAN)
    assert plan["ramMb"] == 4096 and plan["cpuMaxCores"] == 1.5 and plan["storageQuotaGb"] == 1
    assert _psql(f"SELECT count(*) FROM audit_events WHERE action='billing.plan.update' AND detail->>'plan'='{PLAN}'").strip() != "0"

    status, res = staff.call("GET", "/api/admin/billing/resources")
    assert status == 200
    assert res["maxComputers"] > 3
    # One shared base image: every running computer uses the base tag, or an earlier build of it (a bare digest left
    # behind after the base was rebuilt, replaced when that computer is next recreated). Never a per-user tag or commit.
    assert all(i == res["baseImage"] or i.startswith("sha256:") for i in res["imagesInUse"]), res["imagesInUse"]
    assert res["cleanup"]["keepBackups"] >= 1 and res["objectStore"]["enabled"] is True


def test_files_round_trip_through_object_storage_and_full_storage_blocks_writes(res_owner, bot_factory):
    client, staff, user_id = res_owner
    assert staff.call("PUT", f"/api/admin/billing/plans/{PLAN}/assign/{user_id}")[0] == 200
    bot = bot_factory(client, "Storage " + uuid.uuid4().hex[:6])
    task, _ = _send(client, bot, "STORAGE DEMO first")
    assert task["status"] == "completed"

    status, computer = client.call("GET", "/api/computer")
    assert status == 200 and computer.get("computerId")
    cid = computer["computerId"]
    status, pushed = staff.call("POST", f"/api/admin/billing/sync/{cid}/push")
    assert status == 200, pushed
    assert any(r["botId"] == bot and r["error"] is None for r in pushed["reports"]), json.dumps(pushed)
    row = _psql(f"SELECT size_bytes || ' ' || object_key FROM stored_files WHERE bot_id='{bot}' AND path='notes/storage-demo.txt'").strip()
    assert row.startswith("6 files/"), row  # "first\n"

    # Change the file locally, then pretend this disk is a fresh copy and storage holds the newer version: pull restores it.
    task, _ = _send(client, bot, "STORAGE DEMO second")
    assert task["status"] == "completed"
    _psql(f"UPDATE workspace_sync SET token='stale' WHERE bot_id='{bot}'")
    _psql(f"UPDATE stored_files SET mtime_ns = mtime_ns + 3600000000000000 WHERE bot_id='{bot}' AND path='notes/storage-demo.txt'")
    status, pulled = staff.call("POST", f"/api/admin/billing/sync/{cid}/pull")
    assert status == 200 and any(r["botId"] == bot and r["files"] >= 1 and r["error"] is None for r in pulled["reports"]), json.dumps(pulled)
    _, messages = _send(client, bot, "STORAGE READ DEMO")
    assert any("Read result:" in m and "first" in m for m in messages[-3:]), messages[-3:]

    # Over quota: new writes are blocked with a clear message; reads still work.
    _psql(f"INSERT INTO stored_files (bot_id,path,owner_id,size_bytes,mtime_ns,sha256,object_key) VALUES ('{bot}','itest-big.bin','{user_id}',{2 * GIB},1,'x','files/itest/none')")
    status, usage = client.call("GET", "/api/usage/credits")
    assert usage["storage"]["state"] == "full" and "storage is full" in usage["storage"]["message"]
    time.sleep(16)  # the write gate caches storage for 15 s
    task, messages = _send(client, bot, "STORAGE DEMO third")
    assert any("storage is full" in m.lower() for m in messages[-4:]), messages[-4:]
    assert int(_psql(f"SELECT count(*) FROM audit_events WHERE action='storage.full' AND task_id='{task['id']}'")) >= 1
    _, messages = _send(client, bot, "STORAGE READ DEMO")
    assert any("Read result:" in m for m in messages[-3:])

    status, admin_usage = staff.call("GET", "/api/admin/billing/usage")
    row = next(u for u in admin_usage["users"] if u["id"] == user_id)
    assert row["storageState"] == "full" and row["storageQuotaBytes"] == GIB and row["computers"] >= 1 and "ramLimitBytes" in row
    _psql(f"DELETE FROM stored_files WHERE bot_id='{bot}' AND path='itest-big.bin'")

    status, run = staff.call("POST", "/api/admin/billing/cleanup/run")
    assert status == 200 and run["runId"] > 0
    assert _psql(f"SELECT finished_at IS NOT NULL FROM cleanup_runs WHERE id={run['runId']}").strip() == "t"
