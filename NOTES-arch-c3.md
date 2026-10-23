# Architecture chunk c3 follow-up report

Connected computer CONNECT traffic to the authenticated multiplexed WSS companion relay, with 90-second fallback/fail-closed routing. The companion resolves once and pins public addresses. The proxy polls versioned API policy every 10 seconds, keeps the last good policy, denies before first load, and submits host-only decisions to a rate-limited API audit endpoint. Policy changes are audited; stopped computers fetch the latest snapshot on resume. Added in-memory relay, route, policy, audit-redaction, and SSRF tests.

Isolation boundary: one Docker network per computer, plus per-bot UID (`skuid`) output rules for processes sharing that computer.

Files touched: `apps/api/EgressControlRoutes.cs`, `apps/api/EgressRelay.cs`, `apps/api/NetworkPolicyRoutes.cs`, `apps/api/Program.cs`, `apps/web/app/settings/policy/page.tsx`, `companion/README.md`, `companion/egress_client.py`, `companion/pyproject.toml`, `deploy/egress-firewall.py`, `services/computer/Dockerfile`, `services/computer/s6/s6-rc.d/egress-proxy/run`, `services/computer/src/egress/control_plane.py`, `services/computer/src/egress/policy.py`, `services/computer/src/egress/proxy.py`, `services/computer/src/egress/relay.py`, `services/computer/src/egress/relay_tunnel.py`, `src/Compute.Docker/DockerComputeProvider.cs`, `tests/unit/test_egress_client.py`, `tests/unit/test_egress_control_plane.py`, `tests/unit/test_isolation_conformance.py`, `NOTES-arch-c3.md`.

Validation: C# 211 passed; Python 134 passed; isolation conformance 13 passed. Existing nullable and Starlette/httpx warnings remain. Docker-backed exit-IP and live leak checks were unavailable; firewall rules were not applied. Tokens use constant-time checks and are not logged; audit records omit paths and queries.
