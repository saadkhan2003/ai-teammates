# Long run resume implementation note

The lr-1 backend work adds an API-owned checkpoint ledger capped at 8 KB, heartbeat progress details, lease-expiry events, bounded retry/backoff policy, and cumulative/per-attempt worker budgets. Budget exhaustion, repeated no-progress attempts, and the hourly retry limit pause work in `waiting_human`; owners can continue or raise the budget, and their next chat message continues a paused run. Approval decisions wake the waiting task, while cancelled tasks remain terminal.

Resume settings follow `docs/DECISIONS_DEFAULTS.md`: five automatic resumes per rolling hour, 12 coding rounds per attempt / 60 cumulative, and pause-on-budget enabled. Resume actions and owner budget changes are audited. The web notice/card UI and computer-facing presentation remain in the assigned UI chunk.
