# sp-p3 handoff

Implemented composer focus/input prewarm (only 4 isolated lines in chat-pane), owner/policy/quota/audit checks and bounded background admission, adaptive service/CDP readiness, compute stage telemetry, disposable isolated paused templates with fresh bot mounts on claim, generator/compose settings, tests and Phase 3 documentation.

No commits were created: git metadata is read-only; the orchestrator must commit. Starting/current HEAD: caacd7d60fb712f22b7e1a69b6145419a5085376.

Local checks:

- `env -u STACK -u ISOLATION_CHAIN dotnet test tests/unit -nologo -v q` with the supplied TEST_PG_DSN: 553 passed, 0 failed, 0 skipped (includes PostgreSQL-backed HTTP prewarm/audit/recorder test).
- `env -u STACK -u ISOLATION_CHAIN dotnet test tests/compute-contract -nologo -v q`: 30 passed, 0 failed, 0 skipped. Uses fake provider and in-memory Docker HTTP protocol mocks; actual Docker contract cases are not enumerated without COMPUTE_CONTRACT_DOCKER=1.
- `apps/web/node_modules/.bin/tsc --noEmit -p apps/web`: passed.
- `cd apps/web && node --test lib/*.test.mjs`: 57 passed, 0 failed, 0 skipped.
- `env -i PATH=/usr/bin:/bin HOME="$HOME" python3 -m pytest -q tests/unit/test_speed_compute_config.py`: 3 passed, 0 failed, 0 skipped.
- `python3 -m py_compile tests/integration/test_speed_compute.py scripts/gen-stack-compose.py`: passed (3 integration cases authored, not executed).
- `git diff --check`: passed.

The full Python unit suite was attempted through the mandatory heavy wrapper, but it could not acquire a slot: `/workspace/ai-teammates-live/wt-logs/locks/slot-1.lock` and slot 2 are read-only in the sandbox. It ran zero tests and was stopped after five seconds. Do not count this as a suite pass. The orchestrator must run:

```
/workspace/ai-teammates-live/wt-logs/heavy.sh env -i PATH=/usr/bin:/bin HOME="$HOME" python3 -m pytest -q tests/unit --ignore=tests/unit/test_computer_network.py
```

Docker is unavailable here; no daemon/firewall/live-stack actions or paid model calls were attempted. After rebuilding an isolated mock stack, run Docker-backed compute contracts, `pytest -q -s tests/integration/test_speed_compute.py`, and the normal integration/e2e/chaos checks. Use the existing heavy wrapper. The five public prewarm cycles honor the 30-second throttle; allow more than two minutes. They print actual wake samples and p50/p95; pool claim prints its measured ready time. There are no real-stack speed numbers yet.

The pool intentionally warms base/container layers only: Docker cannot rebind live mounts. Each claim destroys a credential-free, mount-free template and creates the real computer with fresh owner-bound volumes. The <5 s Chrome-ready target remains a deployment benchmark, not an asserted property of these mocks. One pool-maintenance API owns a stack's templates; generated secondary APIs opt out of maintenance. Multiple independent inventory writers still need a shared daemon-level capacity coordinator, as documented in docs/SPEED.md.
