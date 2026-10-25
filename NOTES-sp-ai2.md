# sp-ai2 handoff
> Historical handoff for `sp-ai2 handoff`. Status, implementation details, test results, and open items below describe that workstream's recorded checkpoint; verify the current source and guides before treating them as current.


Implementation includes all sixteen control additions in migration 045, additive ASP.NET services, the admin app, mock catalog/golden judge, CLI golden runner, tests and docs/AI_MODELS.md. The non-streaming gateway is delegated into AiControlledGateway.cs to keep the adapter/streaming seam small. No streaming implementation, Docker command, paid API call, secret-file access or git mutation was performed.

Important behavior changes:

- Config saves always create candidates; publishing and nonzero rollout require an eval against the current active version, or an explicit owner-only override reason.
- Config versions cannot be updated/deleted. Activation/rollback moves pointers; activation generations prevent stale cohort bindings after rollback.
- Previously published versions support one-click rollback. Never-published candidates cannot bypass the eval gate through rollback.
- Saved history reserves referenced providers/models so rollback references remain valid. Catalog sync can still warn of upstream deprecation or disappearance.
- USD admission caps cache indexed sums for three seconds and immediately add local completed-call cost. Concurrent/in-flight or other-instance spend can exceed caps by that window; this is documented. Direct providers need manual prices when their usage omits cost.
- Audio transcription keeps its existing contract. Kill stop applies; safe routing, privacy and required downgrades pause audio rather than silently bypassing controls. A fenced waiter job resumes model-control waits when eligible and preserves RunBudget/PauseOnBudget human pauses.
- Eval calls and judge usage contribute to model_calls/spending. Evals refresh emergency and spend controls before every invocation.

Validation (latest results recorded in WT-PROGRESS.md and ignored sp-ai2-*.log files):

- With the supplied shared TEST_PG_DSN exported: `env -u STACK -u ISOLATION_CHAIN dotnet test tests/unit -nologo -v q` — 563 passed, 0 failed, 0 skipped; includes real isolated-database migration/immutability/pointer/rollout/eval/key-slot/spend/waiter regressions.
- `env -i PATH=/usr/bin:/bin HOME="$HOME" python3 -m pytest -q tests/unit/test_ai_mock_providers.py tests/unit/test_video_worker.py` — 22 passed, 0 failed, 0 skipped. Loopback mocks only.
- `node --test apps/web/lib/*.test.mjs` — 55 passed, 0 failed, 0 skipped; source-string/JSX branding scan reads IDs from the mock catalog plus the full requested denylist.
- `apps/web/node_modules/.bin/tsc --noEmit -p apps/web` and `... -p apps/admin` — passed.
- Changed admin browser spec compiled with web tsc, Node types, ES2022/CommonJS and skipLibCheck.
- `python3 -m py_compile tests/integration/*.py evals/eval_real.py services/mock-openrouter/server.py services/agent/worker.py` and `git diff --check` — passed.

BLOCKED: the required full Python command could not start because `/workspace/ai-teammates-live/wt-logs/heavy.sh` opens its shared lock files for writing and this sandbox mounts them read-only. The wrapper loop was stopped; the concurrency rule was not bypassed. Requested orchestrator assistance while continuing implementation. Please run:

```
/workspace/ai-teammates-live/wt-logs/heavy.sh env -i PATH=/usr/bin:/bin HOME="$HOME" python3 -m pytest -q tests/unit --ignore=tests/unit/test_computer_network.py
```

Orchestrator-only: rebuild API/admin/Caddy and run isolated-stack integration tests/integration/test_ai_models.py, existing regression suites and tests/e2e/admin-ai-models.spec.ts (ADMIN_URL; SHOT_DIR for light/dark AI + Speed screenshots). Integration and browser execution were not attempted. Never run the firewall-changing computer-network integration test.

No final commit created: git metadata is read-only and commits belong to the orchestrator. Starting/current HEAD at handoff: 66633da70c8395487490684c8ec6eb5e25793360. Existing concurrent one-line fixes in Platform.cs and admin-app.spec.ts were preserved.
