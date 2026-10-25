# Skills v2 merge resolution

Historical reconciliation and validation record for the Skills v2 merge into `v04-bc`. Migration IDs, test counts, and worktree references below describe that merge checkpoint, not the full current integrated tree.

- WT-PROGRESS.md: retained the full v0.4 history and appended the Skills v2 branch history and merge validation.
- apps/api/Dockerfile: retained migrations 001–040 and added 041 plus built-in guide files; retained one runtime environment/port declaration.
- apps/api/Platform.cs: retained the transactional manifest-driven migration runner and appended 041.
- apps/api/Runtime.cs: retained v0.4 memory, resume, approval rules and desktop fencing; skill tools use the shared scoped library implementation through gated, task/bot-bound execution.
- apps/api/ToolSchema.cs: retained all extended memory fields/tools and added load_skill/write_skill without duplicate tool names.
- services/agent/worker.py: retained the shell poison hook and replay path; guide tools use normal preexec/execute with epochs and idempotency, while catalogs stay in the pinned system prompt across resume/compaction.

Auto-merged Policy.cs classifications, Routes.cs mapping, workspace.tsx props,
ComputeModel.cs redaction, and the Skills pane were reviewed. The shared write
helper preserves owner edit permissions, immutable built-ins, DLP, revisions and
audit events. The compatibility write endpoint requires the execution envelope
and delegates to Runtime.Execute. Guide writes now deduplicate retries; loading
and writing prioritize bot-private guides ahead of shared NULL scopes. Revision
bodies and authors are visible in the Skills pane. The replay table and replay
endpoints remain intact.

Migration mapping: `090_skill_library.sql` → `041_skill_library.sql`. Both build
and runtime manifests list all 41 SQL files exactly once, with linear IDs.
MIGRATIONS_V04.md records the mapping; V0_4.md documents Skills v2.

All commands ran in this worktree, with .NET PATH/DOTNET_ROOT configured.
The first four checks below used `/workspace/ai-teammates-live/wt-logs/heavy.sh`.

| Command (after heavy.sh where applicable) | Passed | Failed | Skipped |
|---|---:|---:|---:|
| `env -u STACK -u ISOLATION_CHAIN dotnet test tests/unit -nologo -v q` | 466 | 0 | 5 |
| `env -u STACK -u ISOLATION_CHAIN python3 -m pytest -q tests/unit --ignore=tests/unit/test_computer_network.py` | 312 | 0 | 1 |
| `node --test apps/web/lib/*.test.mjs` | 47 | 0 | 0 |
| `apps/web/node_modules/.bin/tsc --noEmit -p apps/web` | 1 check | 0 | 0 |
| `python3 -m py_compile tests/integration/*.py` | 33 files | 0 | 0 |

The .NET skips require an isolated TEST_PG_DSN. The Python skip requires the
local PostgreSQL harness. Existing BotMessaging nullable warnings and a
Starlette/httpx deprecation warning remain. Conflict-marker and whitespace scans
are clean. MigrationManifestTests passed as part of the .NET suite.

Docker builds/stacks, integration execution, chaos and Playwright are deferred
to the orchestrator because Docker is unavailable here. Skills integration
coverage includes direct endpoint policy deny/ask, audit, scope precedence,
owner opt-in, retry deduplication and stale/wrong-bot task rejection. Playwright
coverage includes revision bodies/revert/archive and immutable built-ins.
The firewall-changing integration test was not run. No paid APIs were called.

No git staging or commit was attempted; the orchestrator must finalize the
merge. Current HEAD is `40014a38138ec2157bc176d91a5acb9fe482035b`.
