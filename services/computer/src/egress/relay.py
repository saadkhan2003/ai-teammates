"""Desktop-route attachment state shared by the proxy and relay client."""
from __future__ import annotations

import time

RECONNECT_GRACE_SECONDS = 90


class RouteState:
    def __init__(self, *, fail_closed=False, clock=time.monotonic):
        self.fail_closed = bool(fail_closed)
        self.clock = clock
        self.last_attached = None
        self.connected = False

    def attached(self):
        self.connected = True
        self.last_attached = self.clock()

    def dropped(self):
        self.connected = False

    def mode(self):
        if self.connected:
            return "desktop"
        if self.last_attached is not None and self.clock() - self.last_attached <= RECONNECT_GRACE_SECONDS:
            return "desktop"
        return "blocked" if self.fail_closed else "default"
