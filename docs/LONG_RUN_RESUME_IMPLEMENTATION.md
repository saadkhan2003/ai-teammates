# Long run resume implementation note

The lr-1 backend work adds an API-owned checkpoint ledger capped at 8 KB, heartbeat progress details, lease-expiry events, bounded retry/backoff policy, and cumulative/per-attempt worker budgets. Budget exhaustion, repeated no-progress attempts, and the hourly retry limit pause work in `waiting_human`; owners can continue or raise the budget, and their next chat message continues a paused run. Approval decisions wake the waiting task, while cancelled tasks remain terminal.

Resume settings follow `docs/DECISIONS_DEFAULTS.md`: five automatic resumes per rolling hour, 12 coding rounds per attempt / 60 cumulative, and pause-on-budget enabled. Resume actions and owner budget changes are audited. The web notice/card UI and computer-facing presentation remain in the assigned UI chunk.

`POST /internal/tools/execute` now records the worker idempotency key for non-idempotent local tools (`shell`, file writes/edits/deletes, commits, environment setup, and tests). A completed call replays its scrubbed result with `deduped: true`; a concurrent or unresolved claim returns HTTP 409 with `status: in_progress`. These entries are task scoped and removed with the task.
