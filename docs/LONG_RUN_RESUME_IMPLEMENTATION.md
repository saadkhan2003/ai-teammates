# Long run resume implementation note

The lr-1 backend work adds an API-owned checkpoint ledger capped at 8 KB, heartbeat progress details, lease-expiry events, bounded retry/backoff policy, and cumulative/per-attempt worker budgets. Budget exhaustion, repeated no-progress attempts, and the hourly retry limit pause work in `waiting_human`; owners can continue or raise the budget, and their next chat message continues a paused run. Approval decisions wake the waiting task, while cancelled tasks remain terminal.

Resume settings follow `docs/DECISIONS_DEFAULTS.md`: five automatic resumes per rolling hour, 12 coding rounds per attempt / 60 cumulative, and pause-on-budget enabled. Resume actions and owner budget changes are audited. The web notice/card UI and computer-facing presentation remain in the assigned UI chunk.

`POST /internal/tools/execute` now records the worker idempotency key for non-idempotent local tools (`shell`, file writes/edits/deletes, commits, environment setup, and tests). A completed call replays its scrubbed result with `deduped: true`; a concurrent or unresolved claim returns HTTP 409 with `status: in_progress`. These entries are task scoped and removed with the task.

## Chaos test hook (TEST ONLY)

The agent worker supports `WORKER_FORCED_EXIT_AFTER_STEPS=<n>` and `WORKER_FORCED_EXIT_ONCE_FILE=<path>` for integration testing only. After the worker posts a tool result to the durable transcript and its cumulative step count reaches `n`, it atomically creates the once-file and exits with status 137. The hook is disabled unless both variables are set. Use a fresh once-file path for each run; the path must be writable inside the agent container. Do not set these variables in production.

To exercise the in-process kill case, start the mock integration stack with those two variables present in the agent container, then run `PG_CONTAINER=<postgres-container> API_URL=http://127.0.0.1:18081 python3 -m pytest -q tests/integration/test_long_run_chaos.py`. The scripted task uses 30 steps and the hook threshold must be below 30; these scaled-down numbers replace the design plan's 120/40 values to keep the test quick. The test skips if the stack or hook configuration is unavailable. Other cases requiring SIGSTOP/docker pause, repeated kills, a per-task budget override, or a planner poison/shell-append scenario are explicitly skipped with their unmet capability documented in the test.
