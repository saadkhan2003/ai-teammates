"""Authenticated policy polling and decision audit posting for the computer proxy."""
from __future__ import annotations

import json
import os
import tempfile
import urllib.error
import urllib.request
from pathlib import Path


class EgressControlPlane:
    def __init__(self, *, api_url=None, computer_id=None, token=None, policy_path=None, opener=None):
        self.api_url = (api_url or os.environ.get("EGRESS_API_URL", "http://api:8080")).rstrip("/")
        self.computer_id = computer_id or os.environ.get("COMPUTER_ID", "")
        self.token = token or os.environ.get("COMPUTER_TOKEN", "")
        self.policy_path = Path(policy_path or os.environ.get("EGRESS_POLICY_FILE", "/run/egress/policy.json"))
        self.opener = opener or urllib.request.urlopen
        self.version = -1

    def _request(self, path, body=None):
        if not self.computer_id or not self.token or len(self.computer_id) > 80 or len(self.token) > 512:
            raise ValueError("egress control credentials unavailable")
        url = f"{self.api_url}/internal/computers/{self.computer_id}/{path}"
        payload = None if body is None else json.dumps(body, separators=(",", ":")).encode()
        request = urllib.request.Request(url, data=payload, headers={
            "Authorization": "Bearer " + self.token,
            "Content-Type": "application/json",
            "Accept": "application/json",
        }, method="GET" if body is None else "POST")
        with self.opener(request, timeout=5) as response:
            raw = response.read(64_001)
        if len(raw) > 64_000:
            raise ValueError("egress control response too large")
        return json.loads(raw or b"{}")

    def refresh(self):
        snapshot = self._request("egress-policy")
        version = snapshot.get("version")
        if not isinstance(version, int) or version < self.version:
            return False
        entries = snapshot.get("entries", [])
        groups = snapshot.get("groups", [])
        if not isinstance(entries, list) or not isinstance(groups, list):
            raise ValueError("invalid egress policy")
        effective = entries if snapshot.get("locked") else entries + groups
        raw = json.dumps({"version": version, "mode": snapshot.get("mode"), "entries": effective,
                          "locked": bool(snapshot.get("locked")), "failClosed": bool(snapshot.get("failClosed"))}, separators=(",", ":"))
        self.policy_path.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_path = tempfile.mkstemp(prefix="policy-", dir=self.policy_path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(temp_path, 0o600)
            os.replace(temp_path, self.policy_path)
        finally:
            try:
                os.unlink(temp_path)
            except FileNotFoundError:
                pass
        self.version = version
        return True

    def audit(self, host, port, allowed, reason=""):
        # Callers supply only a host, never the request URL or query string.
        return self._request("egress-decisions", {
            "host": host[:253], "port": int(port), "allowed": bool(allowed), "reason": reason[:120],
        })
