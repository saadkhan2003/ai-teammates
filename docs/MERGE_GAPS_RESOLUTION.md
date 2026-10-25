# arch/gaps merge resolution

Historical conflict-resolution record for the `v04-merge` tree. Its final “Remaining work” paragraph describes the state at that merge, not the current project backlog; check the current tests and stack before treating any item as outstanding.

Working tree: `v04-merge`, HEAD `748a0794d731ff08807b3b5fa39a317e845057cd`, incoming `db83eb3`.
Git metadata remains unchanged; the orchestrator must stage the resolved files and create the merge commit.

| Conflicted file | Resolution |
| --- | --- |
| `apps/api/ApprovalRules.cs` | Unified editable host/command/recipient/path matchers and c4 inert shell shapes; preserved safe historical hashes, never-list/DLP restrictions, explicit personal ask, and peer provenance checks. |
| `apps/api/Dockerfile` | Retained every migration COPY from both branches: all 40 SQL files once each. |
| `apps/api/Platform.cs` | Retained all migrations, public-share limiter, Postgres ticket store, and both configuration property names backed by one configuration object. |
| `apps/api/Program.cs` | Kept library/device workers/routes, ticket/lease/egress services/routes, resume watchdog/backoff, and desktop lease expiration/reconciliation; removed gaps' unbounded task-requeue path. |
| `apps/api/Reliability.cs` | Kept bounded resume policy and sweep alongside the authenticated computer doctor route. |
| `apps/api/Routes.cs` | Kept editable approval-rule APIs/audit, fenced resume events, memory lifecycle and routine APIs; combined approval audit with resume signaling. |
| `apps/api/Runtime.cs` | Kept memory, coding and device features alongside reviewer/preexec/desktop leasing; placed the single audited rule lookup after every policy denial and classification step. |
| `apps/web/components/approvals.tsx` | Kept the broader scoped Always allow UI and rule confirmation, with never-list controls intact. |
| `apps/web/components/computer-pane.tsx` | Kept responsive Take control button styling alongside gaps' ticket/lease-aware computer-pane changes. |
| `scripts/backup.sh` | Combined STACK/COMPOSE_PROJECT selection with PG_CONTAINER overrides and noninteractive sudo; removed live-container fallback. |
| `scripts/restore-verify.sh` | Used the same scoped container in shell and Python restore steps while retaining restore/key verification. |
| `services/agent/Dockerfile` | Included resume/compaction/snapshot modules and web_bot_auth in the image. |
| `services/agent/worker.py` | Kept scoped notes, resume and ledger logic; folded retry feedback before resume persistence and retained preexec/web-auth/lease-cancellation behavior. |
| `services/computer/Dockerfile` | Kept tmux, nftables, ffmpeg, Poppler, Pillow, httpx, websockets and both sets of executable scripts. |
| `services/computer/src/server.py` | Kept native/model-coordinate tools, recordings and thumbnails alongside private browser/windows/Teach/terminal support; adapted native input/recording to epoch fencing and stop recording on takeover. |
| `tests/e2e/acceptance.spec.ts` | Kept shared container overrides, hydrated login helper, explicit base URL and incoming lease/egress/reaction assertions. |
| `tests/e2e/computer-view.spec.ts` | Retained the shared dark-surface expectation and its explanatory comment. |
| `tests/e2e/mobile.spec.ts` | Kept HEAD's current workspace tab set and shared Postgres resolver alongside incoming task-linked approval seeding. |
| `tests/e2e/security.spec.ts` | Kept shared container overrides and login helper alongside incoming fenced tab-specific extraction. |
| `tests/integration/test_acceptance.py` | Kept shared service resolvers and incoming approval retry, feedback persistence, egress and ticketed takeover coverage. |
| `tests/integration/test_computer_network.py` | Kept shared container/network filters with explicit private subnet/chain parameters; no live addresses or TEAMS-ISO fallback. This file was compiled only, never executed. |
| `tests/integration/test_computer_recovery.py` | Kept scoped API restart and incoming background approval helper/threading import. |
| `tests/integration/test_edge.py` | Used shared explicit stack URL configuration. |
| `tests/integration/test_plugin_catalog.py` | Used shared explicit stack URL configuration. |
| `tests/integration/test_plugins.py` | Used shared explicit stack URL configuration. |
| `tests/integration/test_stdio_sandbox.py` | Used the shared API resolver, retaining incoming sandbox test changes. |
| `tests/integration/test_v02.py` | Used shared explicit stack URL configuration. |
| `tests/unit/test_computer_displays.py` | Kept model scaling, key/scroll validation and both branches' display tests with authenticated actor/epoch stamps; added recording-takeover coverage. |
| `tests/unit/test_run_guard.py` | Kept cumulative/per-attempt budget tests and fail-closed preexec tests. |

Additional semantic reconciliation:

- `db/020_approval_rules.sql` is the unified CREATE; `db/030_approval_rules.sql` upgrades either historical layout idempotently, backfills c4 hashes into editable matchers, and adds lifecycle/use/revocation fields. No database files were renamed.
- `apps/api/ComputerTools.cs` stamps native operations with actor/desktop epoch and turns control conflicts into a waiting-human response.
- `tests/integration/stack.py` and `tests/e2e/containers.ts` accept consistent STACK/COMPOSE_PROJECT/E2E_COMPOSE_PROJECT/COMPUTE_STACK conventions as applicable, reject conflicting or live stack names, and preserve per-container overrides. Playwright config/global setup use the same resolver; generator/provider COMPUTE_STACK label scoping remains intact.
- Both branches' approval tests remain; added regressions cover legacy inert hashes, shell syntax, ambiguous command/argv payloads, DLP, never-list tools, personal policy and peer provenance. Added Python stack-alias tests.
- Updated image-dependency detection to map the `PIL` import to the `pillow` distribution.

Validation details are recorded in WT-PROGRESS.md. The full .NET unit suite was run once as requested, with focused policy tests after final security refinements. The initial Python run found one image-dependency-test mismatch; the corrected full run passed.

Remaining work for the orchestrator: renumber colliding migration IDs before starting the merged stack; refresh the shared web dependencies or use the Docker image build for the new lockfile dependency `@xterm/xterm`; run Docker integration/chaos/Playwright. Docker was unavailable here, and the firewall-changing integration test was not run.
