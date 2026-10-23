"""In-process desktop lease with bounded takeover drain and held-input cleanup."""
from __future__ import annotations

import asyncio
import inspect
import time
from dataclasses import dataclass
from typing import Awaitable, Callable


class DesktopBusy(RuntimeError):
    code = "DESKTOP_BUSY"


@dataclass(frozen=True)
class LeaseState:
    actor_id: str | None
    role: str | None
    expires_at: float | None


class DesktopLease:
    def __init__(self, agent_ttl: float = 90, human_ttl: float = 120,
                 drain_seconds: float = 2,
                 release_held: Callable[[], object] | None = None):
        self.agent_ttl = agent_ttl
        self.human_ttl = human_ttl
        self.drain_seconds = min(max(drain_seconds, 0), 2)
        self.release_held = release_held
        self._state = LeaseState(None, None, None)
        self._lock = asyncio.Lock()
        self._actions: set[asyncio.Task] = set()

    async def _expire(self) -> None:
        if self._state.expires_at is not None and self._state.expires_at <= time.monotonic():
            self._state = LeaseState(None, None, None)

    async def state(self) -> LeaseState:
        async with self._lock:
            await self._expire()
            return self._state

    def is_held(self) -> bool:
        if self._state.expires_at is not None and self._state.expires_at <= time.monotonic():
            self._state = LeaseState(None, None, None)
        return self._state.actor_id is not None

    def allow_agent(self) -> bool:
        now = time.monotonic()
        if self._state.expires_at is not None and self._state.expires_at <= now:
            self._state = LeaseState(None, None, None)
        if self._state.role == "human":
            return False
        self._state = LeaseState("agent", "agent", now + self.agent_ttl)
        return True

    async def acquire(self, actor_id: str, role: str) -> LeaseState:
        if not actor_id or len(actor_id) > 128 or role not in {"agent", "human"}:
            raise ValueError("invalid lease actor or role")
        async with self._lock:
            await self._expire()
            current = self._state
            if current.actor_id and current.actor_id != actor_id and not (role == "human" and current.role == "agent"):
                raise DesktopBusy("desktop is held by another actor")
            ttl = self.human_ttl if role == "human" else self.agent_ttl
            if role == "human" and current.role == "human" and current.actor_id == actor_id:
                self._state = LeaseState(actor_id, role, time.monotonic() + ttl)
                return self._state
            self._state = LeaseState(actor_id, role, time.monotonic() + ttl)
            if role == "human":
                actions = [task for task in self._actions if task is not asyncio.current_task() and not task.done()]
                for task in actions:
                    task.cancel()
                if actions:
                    try:
                        await asyncio.wait_for(asyncio.gather(*actions, return_exceptions=True), self.drain_seconds)
                    except asyncio.TimeoutError:
                        pass
                await self._release_inputs()
            return self._state

    async def release(self, actor_id: str) -> LeaseState:
        async with self._lock:
            await self._expire()
            if self._state.actor_id and self._state.actor_id != actor_id:
                raise DesktopBusy("desktop is held by another actor")
            await self._release_inputs()
            self._state = LeaseState(None, None, None)
            return self._state

    async def run_action(self, actor_id: str, awaitable: Awaitable):
        async with self._lock:
            await self._expire()
            if self._state.actor_id and self._state.actor_id != actor_id:
                if inspect.iscoroutine(awaitable):
                    awaitable.close()
                raise DesktopBusy("desktop is held by a human")
            task = asyncio.ensure_future(awaitable)
            self._actions.add(task)
        try:
            return await task
        finally:
            self._actions.discard(task)

    async def _release_inputs(self) -> None:
        if self.release_held is None:
            return
        result = self.release_held()
        if inspect.isawaitable(result):
            await result
