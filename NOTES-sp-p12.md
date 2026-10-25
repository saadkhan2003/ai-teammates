> Historical handoff for `sp-p12 handoff`. Status, implementation details, test results, and open items below describe that workstream's recorded checkpoint; verify the current source and guides before treating them as current.

sp-p12 handoff

Phase 1 checkpoint was tested before Phase 2 began (counts in WT-PROGRESS.md). No new migration or package is needed: client_id is the message UUID plus metadata, with transactional idempotent acceptance.

Streaming is additive in apps/api/ModelStream.cs (AiStreamingGateway.Stream); AiProviderWire.cs only changes cache anchors, compatible caching hints and preferred_max_latency. Runtime uses AiRegistry.Resolve for role/model/fallbacks and reads optional max_tokens from the resolved role's serialized config, so the sibling's per-role cap is honored when that field lands. The original complete-response entry point remains in place. During the sp-ai2 merge, connect any new gateway retry/breaker/kill-switch/spend/capability/privacy policy seam to the additive stream adapter as well; those controls are not present in this worktree's starting AiGateway. Do not duplicate the control plane. Re-run both runs' tests after that merge.

The worker image COPY includes parallel_reads.py. Rebuild API, worker, web, mock and Caddy with the orchestrator. New browser specs are registered in the desktop Playwright project; they require LLM_PROVIDER=mock. The new integration contract is tests/integration/test_speed_streaming.py, and the Phase 0 telemetry test now accepts measured TTFT <= total. No Docker/stack/Playwright execution was attempted here. Caddy adaptation and actual route bundle budgets remain orchestrator checks.

DLP intentionally buffers sentences (and whole PEM blocks); short single-sentence output may paint at completion. Tool arguments never enter browser deltas. Routines/peer tasks do not publish draft content. New content-bearing SSE events are owner-scoped in live delivery and replay. Scoped read batches still pass existing preexec/PolicyGate/DLP; row-locked step ledger allocation is covered by a concurrent database test.

Final local verification (2026-10-24)

- `env -u STACK -u ISOLATION_CHAIN dotnet test tests/unit -nologo -v q`: 560 passed, 0 failed, 0 skipped. Required .NET PATH/DOTNET_ROOT and the supplied shared TEST_PG_DSN were set. Existing BotMessaging nullable warnings remain; two nullable-flow warnings on the already-authorized bot id are also reported in message acceptance.
- `env -i PATH=/usr/bin:/bin HOME="$HOME" python3 -m pytest -q tests/unit --ignore=tests/unit/test_computer_network.py`: 376 passed, 0 failed, 1 skipped. Skip is test_desktop_fencing.py::test_postgres_concurrent_acquire_against_temporary_server because postgres/pg_ctl/initdb binaries are unavailable. One existing Starlette/httpx deprecation warning.
- From apps/web, `node --test lib/*.test.mjs`: 62 passed, 0 failed, 0 skipped, including user-app model-name privacy checks.
- `apps/web/node_modules/.bin/tsc --noEmit -p apps/web`: passed.
- `apps/web/node_modules/.bin/tsc --noEmit --skipLibCheck --esModuleInterop --module commonjs --moduleResolution node --target es2022 --types node --typeRoots apps/web/node_modules/@types tests/e2e/speed-phase1.spec.ts tests/e2e/speed-phase2.spec.ts`: passed (typecheck only).
- `python3 -m py_compile tests/integration/test_speed_streaming.py tests/integration/test_speed_telemetry.py services/agent/worker.py services/agent/parallel_reads.py services/mock-openrouter/server.py services/mock-openrouter/planner.py`: passed; no integration tests executed.
- `git diff --check`: passed.

No commit was created (git metadata is read-only and the orchestrator commits). Current HEAD is 66633da70c8395487490684c8ec6eb5e25793360; this is not a commit of the new changes. No dependencies were added and no paid models were called.
