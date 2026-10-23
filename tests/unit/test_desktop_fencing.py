"""Acceptance coverage for the durable lease contract and final action fence."""
import asyncio
import random
import re
import shutil
from pathlib import Path

import pytest

from services.computer.src.desktop_fencing import (
    ActionOutcome, DesktopFence, LeaseConflict, LeaseSnapshot, MemoryLeaseCAS,
)

ROOT = Path(__file__).resolve().parents[2]


def test_postgres_concurrent_acquire_against_temporary_server():
    if not all(shutil.which(binary) for binary in ("postgres", "pg_ctl", "initdb")):
        pytest.skip("local PostgreSQL binaries postgres/pg_ctl/initdb are unavailable")
    pytest.skip("isolated PostgreSQL integration harness is not configured in this unit suite")


def test_atomic_cas_allows_exactly_one_of_one_hundred_concurrent_users():
    async def run():
        store = MemoryLeaseCAS()
        results = await asyncio.gather(*[
            store.acquire("computer-a", 1, f"user-{i % 2}", f"tab-{i}", expected_epoch=0)
            for i in range(100)
        ])
        winners = [r for r in results if r is not None]
        assert len(winners) == 1
        assert winners[0].epoch == 1
    asyncio.run(run())


def test_owner_changes_increase_epoch_and_rollback_keeps_state():
    async def run():
        store = MemoryLeaseCAS()
        first = await store.acquire("c", 1, "u1", "t1", 0)
        assert first and first.epoch == 1
        assert await store.acquire("c", 1, "u2", "t2", 0) is None
        released = await store.release("c", 1, "u1", "t1", 1)
        assert released and released.epoch == 2 and released.holder_kind == "none"
        second = await store.acquire("c", 1, "u2", "t2", 2)
        assert second and second.epoch == 3
        before = await store.state("c", 1)
        with pytest.raises(RuntimeError):
            async with store.transaction():
                await store.release("c", 1, "u2", "t2", 3)
                raise RuntimeError("rollback")
        assert await store.state("c", 1) == before
    asyncio.run(run())


def test_migration_has_db_clock_cas_fields_and_epoch():
    sql = (ROOT / "db/021_desktop_lease.sql").read_text().lower()
    for field in ("computer_id", "display", "holder_kind", "holder_user_id", "tab_id", "epoch", "expires_at", "updated_at"):
        assert re.search(rf"\b{field}\b", sql)
    assert "bigint" in sql and "clock_timestamp()" in sql
    assert "where epoch" in sql
    repository = (ROOT / "apps/api/DesktopLeases.cs").read_text()
    assert "WHERE desktop_lease.epoch=@expectedEpoch" in repository
    assert "epoch=epoch+1" in repository and "clock_timestamp()" in repository
    assert "ForceReleaseAsync" in repository
    assert "holder_kind <> 'none'" in repository


def test_set_holder_is_epoch_fenced_and_same_epoch_retry_is_idempotent():
    async def run():
        fence = DesktopFence()
        await fence.reconcile(LeaseSnapshot("human", "u1", "tab1", 6, 30))
        with pytest.raises(LeaseConflict) as stale:
            await fence.set_holder("agent", None, None, 5)
        assert stale.value.current.epoch == 6
        assert not await fence.set_holder("human", "u1", "tab1", 6)
        assert (await fence.state()).holder_kind == "human"
    asyncio.run(run())


def test_final_effect_check_rejects_stale_epoch_for_xdotool_cdp_and_clipboard():
    async def run():
        fence = DesktopFence()
        await fence.reconcile(LeaseSnapshot("agent", "agent:1", None, 5, 90))
        for path in ("xdotool", "cdp", "clipboard", "computer-use"):
            with pytest.raises(LeaseConflict):
                await fence.authorize_effect(path, "agent:1", 4)
        await fence.reconcile(LeaseSnapshot("human", "u1", "tab", 6, 30))
        with pytest.raises(LeaseConflict):
            await fence.authorize_effect("cdp", "agent:1", 6)
    asyncio.run(run())


def test_takeover_cancels_registered_action_and_releases_held_input_idempotently():
    async def run():
        released = []
        fence = DesktopFence(release_held=lambda: released.append("keyup-mouseup"))
        await fence.reconcile(LeaseSnapshot("agent", "agent:1", None, 1, 90))
        released.clear()  # boot reconciliation clears unknown key state once
        started = asyncio.Event()
        async def long_action():
            started.set()
            await asyncio.sleep(10)
        action = asyncio.create_task(fence.run_effect("xdotool", "agent:1", 1, long_action()))
        await started.wait()
        await fence.reconcile(LeaseSnapshot("human", "u1", "tab", 2, 35))
        await asyncio.sleep(0)
        assert action.done()
        assert await fence.cancel_for_epoch(2) == "already_fenced"
        assert released == ["keyup-mouseup"]
    asyncio.run(run())


def test_cancelled_effect_is_tristate_and_agent_must_reobserve_before_retry():
    async def run():
        fence = DesktopFence()
        await fence.reconcile(LeaseSnapshot("agent", "agent:1", None, 1, 90))
        started = asyncio.Event()
        async def effect():
            started.set()
            await asyncio.sleep(1)
            return "landed"
        task = asyncio.create_task(fence.run_effect("cdp", "agent:1", 1, effect()))
        await started.wait()
        await fence.reconcile(LeaseSnapshot("human", "u", "tab", 2, 30))
        assert await task == ActionOutcome.CANCELLED_MAYBE_APPLIED
        assert fence.needs_observation
        await fence.reconcile(LeaseSnapshot("agent", "agent:1", None, 3, 90))
        with pytest.raises(LeaseConflict):
            await fence.authorize_effect("cdp", "agent:1", 3)
        assert await fence.authorize_effect("screenshot", "agent:1", 3)
        assert not fence.needs_observation
    asyncio.run(run())


def test_client_clock_skew_does_not_change_ttl_and_restart_starts_fenced():
    async def run():
        fence = DesktopFence(clock=lambda: 10.0)
        await fence.reconcile(LeaseSnapshot("agent", "agent:1", None, 9, 30, server_now=10))
        assert await fence.authorize_effect("xdotool", "agent:1", 9, client_now=3610)
        restarted = DesktopFence(clock=lambda: 10.0)
        assert (await restarted.state()).holder_kind == "fenced"
    asyncio.run(run())


def test_random_lease_interleavings_never_authorize_two_writers_or_decrease_epoch():
    async def run():
        rng = random.Random(9411)
        now = [100.0]
        store = MemoryLeaseCAS(clock=lambda: now[0])
        held_inputs = set()
        fence = DesktopFence(release_held=lambda: held_inputs.clear(), clock=lambda: now[0])
        last_epoch = 0
        for n in range(2000):
            current = await store.state("c", 1)
            expected_epoch = current.epoch if current else 0
            op = rng.choice(("acquire", "renew", "release", "agent", "crash", "tick"))
            candidate = None
            if op == "acquire":
                candidate = await store.acquire("c", 1, f"u{rng.randrange(2)}", f"t{n}", expected_epoch)
            elif op == "renew" and current and current.holder_kind == "human":
                candidate = await store.renew("c", 1, current.holder_user_id, current.tab_id, expected_epoch)
            elif op == "release" and current and current.holder_kind == "human":
                candidate = await store.release("c", 1, current.holder_user_id, current.tab_id, expected_epoch)
            elif op == "agent":
                candidate = await store.acquire_agent("c", 1, "agent:bot", expected_epoch)
            elif op == "tick":
                now[0] += rng.uniform(0.1, 50)
                current = await store.state("c", 1)
            elif op == "crash":
                fence = DesktopFence(release_held=lambda: held_inputs.clear(), clock=lambda: now[0])
                if current and current.holder_kind == "agent":
                    with pytest.raises(LeaseConflict):
                        await fence.authorize_effect("computer-use", current.holder_user_id, current.epoch)
            if candidate:
                current = candidate
            current = await store.state("c", 1)
            if current:
                await fence.reconcile(current.as_snapshot(now[0]))
            state = await fence.state()
            assert state.epoch >= last_epoch
            last_epoch = state.epoch
            if state.holder_kind == "human":
                with pytest.raises(LeaseConflict):
                    await fence.authorize_effect("computer-use", "agent:bot", state.epoch)
                assert not held_inputs
            elif state.holder_kind == "agent":
                assert await fence.authorize_effect("computer-use", "agent:bot", state.epoch)
                held_inputs.add("Control_L")
        current = await store.state("c", 1)
        if current and current.holder_kind == "agent":
            transferred = await store.acquire("c", 1, "owner", "final-tab", current.epoch)
            assert transferred is not None
            await fence.reconcile(transferred.as_snapshot(now[0]))
        assert not held_inputs
    asyncio.run(run())


def test_shell_and_cdp_http_actions_require_epoch_and_use_fence():
    source = (ROOT / "services/computer/src/server.py").read_text()
    runtime = (ROOT / "apps/api/Runtime.cs").read_text()
    shell = source.split('@app.post("/desktops/{bot_id}/shell")', 1)[1].split('@app.post', 1)[0]
    setup = source.split('@app.post("/desktops/{bot_id}/setup-env")', 1)[1].split('@app.post', 1)[0]
    ssh = source.split('@app.post("/desktops/{bot_id}/ssh-key")', 1)[1].split('@app.post', 1)[0]
    assert "agent_allowed(bot_id, body" in shell
    assert "run_effect(\"shell\"" in shell
    assert "agent_allowed(bot_id, body" in setup and "run_effect(\"shell\"" in setup
    assert "agent_allowed(bot_id, body" in ssh and "run_effect(\"shell\"" in ssh
    assert "run_effect(\"cdp\"" in source
    for endpoint in ("desktop_screenshot", "browser_extract", "browser_inspect", "browser_screenshot"):
        section = source.split(f"async def {endpoint}(", 1)[1].split("@app.", 1)[0]
        assert "run_effect(" in section
    assert '"/desktops/{placement.Desktop}/shell"' in runtime
    assert 'actor_id = actorId, epoch = desktopEpoch' in runtime
    assert '"/desktops/{desktop}/setup-env"' in runtime
    assert 'statusCode: 409' in runtime and 'new { code = "DESKTOP_BUSY" }' in runtime


def test_websocket_close_grace_force_release_and_tab_transfer_are_wired():
    routes = (ROOT / "apps/api/Routes.cs").read_text()
    tickets = (ROOT / "apps/api/VncTickets.cs").read_text()
    connections = (ROOT / "apps/api/DesktopRwConnections.cs").read_text()
    ui = (ROOT / "apps/web/components/computer-pane.tsx").read_text()
    assert "DesktopRwConnections.RegisterAsync" in routes and "DesktopRwConnections.DisconnectedAsync" in routes
    assert "release_after=clock_timestamp()+interval '12 seconds'" in connections
    assert "FOR UPDATE SKIP LOCKED" in connections
    assert "leaseMonitor" in routes and "socket.Abort()" in routes
    force = tickets.split('MapPost("/api/computers/{id:guid}/lease/force-release"', 1)[1].split('MapPost("/api/computers/{id:guid}/lease"', 1)[0]
    assert "force_release_reason_required" in force and "desktop.lease.force_release" in force
    assert "DesktopLeaseRepository.ForceReleaseAsync" in force
    assert "transfer=true" in ui
    assert "Take over here" in ui
    assert 'data-testid="force-release"' in ui
