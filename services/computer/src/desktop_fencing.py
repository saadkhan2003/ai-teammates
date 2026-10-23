"""Last-step epoch fence for every computer side effect.

The API's Postgres desktop_lease row is authoritative. This process starts
fenced and only opens a holder after an authenticated API reconciliation.
"""
from __future__ import annotations

import asyncio
import copy
import inspect
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from enum import Enum
from typing import Callable


@dataclass(frozen=True)
class LeaseSnapshot:
    holder_kind: str
    holder_user_id: str | None
    tab_id: str | None
    epoch: int
    ttl: float
    server_now: float | None = None


class LeaseConflict(RuntimeError):
    def __init__(self, current: LeaseSnapshot):
        super().__init__("desktop lease epoch or holder mismatch")
        self.current = current


class ActionOutcome(str, Enum):
    COMPLETED = "completed"
    CANCELLED_NOT_APPLIED = "cancelled_not_applied"
    CANCELLED_MAYBE_APPLIED = "cancelled_maybe_applied"


class DesktopFence:
    def __init__(self, release_held: Callable[[], object] | None = None, clock=time.monotonic):
        self._clock = clock
        self._release_held_callback = release_held
        self._state = LeaseSnapshot("fenced", None, None, 0, 0)
        self._deadline = 0.0
        self._lock = asyncio.Lock()
        self._actions: dict[asyncio.Task, tuple[int, bool]] = {}
        self._cancelled_epoch = -1
        self._expired_owner: tuple[str, str | None, str | None] | None = None
        self.needs_observation = False

    async def state(self) -> LeaseSnapshot:
        async with self._lock:
            self._expire_locked()
            return self._state

    def _expire_locked(self) -> None:
        if self._state.holder_kind in ("human", "agent") and self._deadline <= self._clock():
            self._expired_owner = (self._state.holder_kind, self._state.holder_user_id, self._state.tab_id)
            self._state = LeaseSnapshot("fenced", None, None, self._state.epoch, 0)

    async def reconcile(self, state: LeaseSnapshot) -> None:
        if state.epoch < 0 or state.ttl < 0 or state.holder_kind not in {"none", "agent", "human", "fenced"}:
            raise ValueError("invalid lease state")
        async with self._lock:
            self._expire_locked()
            current = self._state
            if state.epoch < current.epoch:
                raise LeaseConflict(current)
            if state.epoch == current.epoch:
                same_owner = (state.holder_kind, state.holder_user_id, state.tab_id) == (current.holder_kind, current.holder_user_id, current.tab_id)
                same_fenced_none = state.holder_kind == "none" and current.holder_kind == "fenced" and current.holder_user_id is None and current.tab_id is None
                expired_owner = self._expired_owner == (state.holder_kind, state.holder_user_id, state.tab_id)
                if not same_owner and not same_fenced_none and not (current.holder_kind == "fenced" and expired_owner):
                    raise LeaseConflict(current)
            changed_owner = (state.holder_kind, state.holder_user_id, state.tab_id) != (current.holder_kind, current.holder_user_id, current.tab_id)
            if changed_owner and current.holder_kind in ("agent", "human"):
                await self._cancel_locked(state.epoch)
            elif current.holder_kind == "fenced":
                # Reconcile after process restart begins with unknown physical input state.
                await self._release_held()
            self._state = state
            self._deadline = self._clock() + state.ttl
            self._expired_owner = None
            if state.holder_kind == "none":
                self._state = LeaseSnapshot("fenced", None, None, state.epoch, 0)

    async def set_holder(self, holder_kind: str, user_id: str | None, tab_id: str | None, epoch: int) -> bool:
        async with self._lock:
            self._expire_locked()
            state = self._state
            requested_owner = (holder_kind, user_id, tab_id)
            if epoch == state.epoch and (requested_owner == (state.holder_kind, state.holder_user_id, state.tab_id) or
                                         state.holder_kind == "fenced" and self._expired_owner == requested_owner):
                ttl = 35 if holder_kind == "human" else 90 if holder_kind == "agent" else 0
                self._state = LeaseSnapshot(holder_kind, user_id, tab_id, epoch, ttl)
                self._deadline = self._clock() + ttl
                self._expired_owner = None
                return False
            if epoch <= state.epoch:
                raise LeaseConflict(state)
        await self.reconcile(LeaseSnapshot(holder_kind, user_id, tab_id, epoch, 35 if holder_kind == "human" else 90))
        return True

    async def authorize_effect(self, path: str, actor_id: str, epoch: int, client_now: float | None = None) -> bool:
        del client_now  # client clocks never grant authority
        async with self._lock:
            self._expire_locked()
            state = self._state
            agent_actor = actor_id == state.holder_user_id or actor_id.startswith("agent:")
            if (epoch != state.epoch or state.holder_kind != "agent" or
                    not agent_actor or self._deadline <= self._clock()):
                raise LeaseConflict(state)
            if self.needs_observation:
                if path not in {"screenshot", "browser_screenshot"}:
                    raise LeaseConflict(state)
                self.needs_observation = False
            return True

    async def run_effect(self, path: str, actor_id: str, epoch: int, awaitable):
        await self.authorize_effect(path, actor_id, epoch)
        async with self._lock:
            # Recheck at the last step before starting the effect.
            self._expire_locked()
            state = self._state
            agent_actor = actor_id == state.holder_user_id or actor_id.startswith("agent:")
            if epoch != state.epoch or state.holder_kind != "agent" or not agent_actor:
                if inspect.iscoroutine(awaitable):
                    awaitable.close()
                raise LeaseConflict(state)
            action_started = False

            async def invoke():
                nonlocal action_started
                action_started = True
                return await awaitable

            task = asyncio.ensure_future(invoke())
            self._actions[task] = (epoch, False)
        try:
            return await task
        except asyncio.CancelledError:
            if action_started:
                self.needs_observation = True
                return ActionOutcome.CANCELLED_MAYBE_APPLIED
            return ActionOutcome.CANCELLED_NOT_APPLIED
        finally:
            self._actions.pop(task, None)

    async def _cancel_locked(self, takeover_epoch: int) -> None:
        if self._cancelled_epoch == takeover_epoch:
            return
        self._cancelled_epoch = takeover_epoch
        active = [task for task in self._actions if not task.done()]
        for task in active:
            task.cancel()
        if active:
            try:
                await asyncio.wait_for(asyncio.gather(*active, return_exceptions=True), timeout=2)
            except asyncio.TimeoutError:
                for task in active:
                    task.cancel()
        await self._release_held()

    async def _release_held(self) -> None:
        if self._release_held_callback is None:
            return
        value = self._release_held_callback()
        if inspect.isawaitable(value):
            await value

    async def cancel_for_epoch(self, epoch: int) -> str:
        async with self._lock:
            if self._cancelled_epoch == epoch:
                return "already_fenced"
            await self._cancel_locked(epoch)
            return "cancelled"

    def mark_observed(self) -> bool:
        was_needed = self.needs_observation
        self.needs_observation = False
        return was_needed


@dataclass
class _MemoryLease:
    holder_kind: str
    holder_user_id: str | None
    tab_id: str | None
    epoch: int
    expires_at: float

    def as_snapshot(self, now: float | None = None) -> LeaseSnapshot:
        return LeaseSnapshot(self.holder_kind, self.holder_user_id, self.tab_id, self.epoch,
                             max(0, self.expires_at - (time.monotonic() if now is None else now)))


class MemoryLeaseCAS:
    """Concurrent fake mirrors the migration's single-row compare-and-swap."""
    def __init__(self, clock=time.monotonic):
        self._clock = clock
        self._rows: dict[tuple[str, int], _MemoryLease] = {}
        self._lock = asyncio.Lock()

    async def state(self, computer_id: str, display: int) -> _MemoryLease | None:
        async with self._lock:
            row = self._rows.get((computer_id, display))
            if row is not None and row.holder_kind != "none" and row.expires_at <= self._clock():
                row = _MemoryLease("none", None, None, row.epoch + 1, self._clock())
                self._rows[(computer_id, display)] = row
            return copy.copy(row)

    async def acquire(self, computer_id: str, display: int, user_id: str, tab_id: str, expected_epoch: int, ttl: float = 35) -> _MemoryLease | None:
        if len(computer_id) > 128 or len(user_id) > 128 or len(tab_id) > 128 or display < 1 or ttl <= 0:
            raise ValueError("invalid lease")
        async with self._lock:
            key = (computer_id, display)
            old = self._rows.get(key)
            epoch = old.epoch if old else 0
            active = bool(old and old.holder_kind != "none" and old.expires_at > self._clock())
            same = bool(active and old.holder_user_id == user_id and old.tab_id == tab_id)
            if epoch != expected_epoch or (active and not same and old.holder_kind != "agent"):
                return None
            next_epoch = epoch if same else epoch + 1
            row = _MemoryLease("human", user_id, tab_id, next_epoch, self._clock() + min(ttl, 45))
            self._rows[key] = row
            return copy.copy(row)

    async def acquire_agent(self, computer_id: str, display: int, agent_id: str, expected_epoch: int, ttl: float = 90) -> _MemoryLease | None:
        async with self._lock:
            key = (computer_id, display)
            old = self._rows.get(key)
            epoch = old.epoch if old else 0
            active = bool(old and old.holder_kind != "none" and old.expires_at > self._clock())
            if epoch != expected_epoch or active:
                return None
            row = _MemoryLease("agent", agent_id, None, epoch + 1, self._clock() + min(ttl, 90))
            self._rows[key] = row
            return copy.copy(row)

    async def renew(self, computer_id: str, display: int, user_id: str, tab_id: str, expected_epoch: int, ttl: float = 35) -> _MemoryLease | None:
        async with self._lock:
            key = (computer_id, display)
            old = self._rows.get(key)
            if (old is None or old.epoch != expected_epoch or old.holder_kind != "human" or
                    old.holder_user_id != user_id or old.tab_id != tab_id or old.expires_at <= self._clock()):
                return None
            row = _MemoryLease("human", user_id, tab_id, old.epoch, self._clock() + min(ttl, 45))
            self._rows[key] = row
            return copy.copy(row)

    async def release(self, computer_id: str, display: int, user_id: str, tab_id: str, expected_epoch: int) -> _MemoryLease | None:
        async with self._lock:
            key = (computer_id, display)
            old = self._rows.get(key)
            if old is None or old.epoch != expected_epoch or old.holder_user_id != user_id or old.tab_id != tab_id:
                return None
            row = _MemoryLease("none", None, None, old.epoch + 1, self._clock())
            self._rows[key] = row
            return copy.copy(row)

    @asynccontextmanager
    async def transaction(self):
        async with self._lock:
            before = copy.deepcopy(self._rows)
        try:
            yield
        except BaseException:
            async with self._lock:
                self._rows = before
            raise
