import asyncio

import pytest

from services.computer.src.desktop_lease import DesktopBusy, DesktopLease


def test_human_lease_blocks_agent_and_same_actor_renews():
    asyncio.run(_human_lease_blocks_agent_and_same_actor_renews())

async def _human_lease_blocks_agent_and_same_actor_renews():
    lease = DesktopLease(agent_ttl=90, human_ttl=120)
    first = await lease.acquire("human-1", "human")
    renewed = await lease.acquire("human-1", "human")
    assert first.expires_at < renewed.expires_at
    with pytest.raises(DesktopBusy):
        await lease.acquire("agent-1", "agent")
    assert (await lease.state()).actor_id == "human-1"


def test_second_human_is_busy_then_release_clears_owner():
    asyncio.run(_second_human_is_busy_then_release_clears_owner())

async def _second_human_is_busy_then_release_clears_owner():
    lease = DesktopLease()
    await lease.acquire("human-1", "human")
    with pytest.raises(DesktopBusy):
        await lease.acquire("human-2", "human")
    await lease.release("human-1")
    assert (await lease.state()).actor_id is None


def test_takeover_cancels_action_drains_and_releases_held_input():
    asyncio.run(_takeover_cancels_action_drains_and_releases_held_input())

async def _takeover_cancels_action_drains_and_releases_held_input():
    released = []
    lease = DesktopLease(drain_seconds=0.05, release_held=lambda: released.append(True))
    action = asyncio.create_task(lease.run_action("agent-1", asyncio.sleep(2)))
    await asyncio.sleep(0)
    await lease.acquire("human-1", "human")
    with pytest.raises(asyncio.CancelledError):
        await action
    assert released == [True]


def test_expired_human_lease_allows_agent_again():
    asyncio.run(_expired_human_lease_allows_agent_again())

async def _expired_human_lease_allows_agent_again():
    lease = DesktopLease(human_ttl=0.01)
    await lease.acquire("human-1", "human")
    await asyncio.sleep(0.02)
    assert (await lease.state()).actor_id is None
    assert lease.allow_agent()
    assert (await lease.state()).role == "agent"
