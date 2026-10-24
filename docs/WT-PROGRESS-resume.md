# arch/resume progress (design section 6)
Done: steps 0-10 (supervisor/report + attempt log, checkpoint ledger, cumulative budgets, append-only transcript, resume brief + unknown_outcome, resume policy, notices + Continue/Raise/Stop cards, compaction, watchdog, git snapshot refs, chaos hardening), server-side dedupe of non-idempotent tools on idempotencyKey, budget settings UI.
Test isolation: tests/integration/stack.py and tests/e2e/containers.ts take every container name from COMPOSE_PROJECT / E2E_COMPOSE_PROJECT (+ per-container overrides). scripts/backup.sh and restore-verify.sh honour PG_CONTAINER.
Not run on the isolated stack: tests/integration/test_computer_network.py (applies deploy/computer-isolation.sh host-wide iptables rules, which would also hit the live stack); docker variant of the compute contract (uses the shared teammates-computer:dev image).
Notes: .compose-resume.yml (untracked) = compose copy with own networks/subnet/ports; wt-logs/resume-ports.yml adds ports 48080/48081, RunBudget__ChatRounds=200, MAX_COMPUTERS=5, WORKER_POISON_MARKER.

## Suite status (2026-10-24, isolated project `resume`)
- C# unit 327/327; pytest unit 140/140; web node 43/43; tsc clean; compute contract 19/19 (docker variant skipped: shared computer image).
- Chaos (test_long_run_chaos.py) 6/6. Integration 74/75 in one full run; the one failure (test_reliability_v04, ResourceExhausted at 3 computers) passes 3/3 with MAX_COMPUTERS=5 in the resume override. test_computer_network.py excluded (host-wide iptables).
- Playwright 75/75, run one spec file at a time with resume-api restarted between files (the in-memory login limiter is 30/10 min per IP and all traffic shares the caddy gateway IP).
- v0.4-codex merged into arch/resume (brings e08797c library hover/preview fix and its spec updates). bot-messaging Save locator made exact (the work budget has its own Save button); mobile Last-Event-ID check tolerates a newer id (agent reply race).
