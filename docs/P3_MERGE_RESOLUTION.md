# P3 merge resolution

Content conflicts are reconciled in the worktree. Git metadata was not changed; the index still lists 70 unmerged paths until the orchestrator stages them. No Docker, live stack, real model calls, installs, or git mutation commands were used.

## Shared decisions

- v0.5-local owns SQL 001–051. Slots 052–056 remain reserved. Origin migrations moved to 057_chat_ui, 058_coding_job_diff, 059_theme, 060_recommended_apps, 061_account, 062_uptime and 063_admin_console; COPY lines, manifest and literal test/doc references were updated.
- Replies use v0.5 `reply_to_message_id`; legacy JSON aliases remain readable, legacy inputs are validated and old existing columns are backfilled. No duplicate reply columns are introduced. Coding job cards remain separate from long-running computer jobs/task plans because their contracts differ.
- v0.5 `billing_plans` and weekly usage own shared plan/credit/resource configuration. Origin free/team IDs are added without overwriting existing plans. Origin mock invoices, refunds, top-up and account routes remain. Account and staff billing reads use the weekly meter; plan assignments, grants, overrides and allowance edits affect that meter. Legacy payload fields remain. Origin plan_limits is removed as duplicate schema; plan editors use canonical names/ranges. Per-user overrides keep bounded limits and respect v0.5 RAM/CPU floors.
- Origin admin cleanup history uses `admin_cleanup_runs` (UUID), leaving v0.5 `cleanup_runs` (bigserial, file/backup metrics) intact. These are different operations.
- v0.5 AI routing/configuration remains authoritative. Origin per-model enabled/kill/daily cap restrictions and global kill are enforced in the shared gateway before normal, streaming, emergency-target and router-fallback wire calls. Added isolated unit coverage makes sure blocked targets never reach the wire.
- The user application has no model/provider labels or configured model slots. The privacy regression passes. Account identity-provider variables remain ordinary account functionality. Admin-only model controls remain available.
- No visual redesign. Existing token markup/classes are retained where practical; behavioral unions take precedence. Additional route loading boundaries preserve the imported performance contract.
- Dependency manifests use unions/higher versions. All three locks remain byte-for-byte v0.5-local. `NEEDS-NPM.md` records the required package-lock-only regeneration, npm ci and repeat audit. Current retained locks all audit at zero.

## Every conflicted path

| Path | Resolution |
| --- | --- |
| `Caddyfile` | Shared admin snippet retains Origin allowlist and same-origin API/health, v0.5 compression and unbuffered events; default admin listener retained. |
| `apps/admin/app/billing/page.tsx` | Keep Origin invoices/grants/top-up/refunds and embed v0.5 weekly plan/rate/usage/resource/cleanup controls. |
| `apps/admin/app/globals.css` | Retain existing tokens and font settings; no redesign. |
| `apps/admin/app/login/page.tsx` | Keep existing submit/hydration/auth behavior; conflict was styling only. |
| `apps/admin/app/page.tsx` | Keep Origin staff overview/statistics plus v0.5 AI overview and computer health. |
| `apps/admin/app/settings/page.tsx` | Keep full Origin branding/legal/data/settings forms; expose AI-model management and edit canonical weekly allowances. |
| `apps/admin/app/users/[id]/page.tsx` | Retain complete Origin plan/access/note/reset/ban/delete/impersonation management; actual plans/credits use v0.5 canonical data. |
| `apps/admin/app/users/page.tsx` | Retain complete Origin searchable/filterable user and organization management. |
| `apps/admin/components/admin-state.tsx` | Keep Origin staff role gates, groups, themes, impersonation and maintenance; add AI models/speed and canonical standard plan; submit all allowance fields. |
| `apps/admin/lib/api.ts` | Retain owner/admin/support/readonly roles and capability predicates. |
| `apps/admin/next.config.ts` | Keep existing config plus v0.5 import optimization. |
| `apps/admin/styles/theme-tokens.css` | Retain existing token values; conflict was styling only. |
| `apps/api/Dockerfile` | Union runtime resources and all SQL COPY lines; Origin SQL now 057–063, with v0.5 001–051 unchanged. |
| `apps/api/Platform.cs` | Keep v0.5 serialized transactional manifest migration runner and speed-prefix repair; union Origin admin/account configuration and runtime samples/services. |
| `apps/api/Policy.cs` | Union built-in tools and write classifications, including legacy replies, memory edits, skills, video, peers, jobs and routines. Existing policy/DLP gates retained. |
| `apps/api/Program.cs` | Union Origin admin IP middleware/uptime with v0.5 routing, resource/cleanup maintenance, telemetry, prewarm, lease reconciliation and stack isolation. |
| `apps/api/Reliability.cs` | Use v0.5 safe error codes and separate step/time budget messages; legacy missing-key inputs normalize to model_access_required. |
| `apps/api/Routes.cs` | Union account/theme/timezone, pagination, parts, legacy replies, reactions, coding cards and peer approvals. Keep epoch-fenced completion, test gate, feedback consumption and quiet peer/routine completion. Do not expose model/provider identity in user status. |
| `apps/api/Runtime.cs` | Keep v0.5 controlled normal/streaming gateways, roles and lease checks; inject Origin app guide/live context; retain coding-job and reply tools. |
| `apps/api/Teammates.Api.csproj` | Union embedded app guide/reply/workspace scripts and cryptography dependencies, retaining the existing higher versions. |
| `apps/web/app/dev/screens/page.tsx` | Retain Origin fixture screen plus the lazy v0.5 gallery catalog. |
| `apps/web/app/globals.css` | Keep automatically merged token/features and v0.5 state/motion variables; no theme redesign. |
| `apps/web/app/settings/computer/page.tsx` | Keep complete pairing/revoke/version/device capabilities behavior and existing hooks. |
| `apps/web/app/settings/page.tsx` | Keep Origin theme persistence/account controls; retain v0.5 editor switches and persist timezone to routine scheduling API. |
| `apps/web/app/settings/plugins/page.tsx` | Keep existing settings wrapper and full plugin component. |
| `apps/web/app/settings/policy/page.tsx` | Union policy/DLP class controls and v0.5 network mode, groups and entries. |
| `apps/web/app/settings/secrets/page.tsx` | Keep generic AI connection, add/rotate/delete/test/usage/secret request behavior; preserve Vault anchor and write-only inputs. |
| `apps/web/app/settings/usage/page.tsx` | Expose both account/history/invoice surfaces and v0.5 weekly credits, resources, on-demand and upgrades. Billing reads/plan edits/grants now use the canonical weekly meter. |
| `apps/web/app/system/page.tsx` | Retain Origin health/invitation/usage UI and complete merged system behavior; omit obsolete provider/dev badge. |
| `apps/web/components/app-shell.tsx` | Union v0.5 prefetch/event/connection behavior and Origin account/connect-app/avatar/sidebar/command/dialog features; retain all routes and roster controls. |
| `apps/web/components/approvals.tsx` | Keep complete relayed/thread approval context and existing decision UI/gates. |
| `apps/web/components/bot-avatar.tsx` | Retain Origin artwork/hooks with v0.5 shared body/eye/morph clock and primary badge; shared pure shape module breaks the circular import. |
| `apps/web/components/chat-pane.tsx` | Keep v0.5 ordered quotes/replies, optimistic/deduplicated sending, pagination, streaming, plans, evidence and peer rows. Wire Origin job cards, grouped image/file/video media, uploads, composer presence, reaction/reply hooks and new-message count into the retained renderer. |
| `apps/web/components/computer-pane.tsx` | Keep v0.5 lease/window/reconnect/input/teaching/fullscreen state machine; retain compact watch/control actions, legacy open/wake hooks and caption. No parallel desktop sessions. |
| `apps/web/components/memory-pane.tsx` | Keep v0.5 edits, rules, suggestions, history and focus behavior with existing props/hooks. |
| `apps/web/components/plugins-pane.tsx` | Retain existing loading status semantics and the merged full plugin/skill behavior. |
| `apps/web/components/routines-pane.tsx` | Retain the Origin compatibility component; active workspace also exposes the more complete v0.5 RoutinesSection. |
| `apps/web/components/settings-nav.tsx` | Keep Origin grouped account navigation and add the real v0.5 approval-rules route; update both app-guide copies/anchors. |
| `apps/web/components/skills-pane.tsx` | Keep v0.5 guide editor/library behavior and saved workflow interfaces. |
| `apps/web/components/tasks-pane.tsx` | Keep full v0.5 resume/budget/test state and saving workflows; use generic AI connection status. |
| `apps/web/components/ui/button.tsx` | Retain existing token-based primitive markup/props/accessibility; conflict only changes classes, with merged behavior preserved. |
| `apps/web/components/ui/card.tsx` | Retain existing token-based primitive markup/props/accessibility; conflict only changes classes, with merged behavior preserved. |
| `apps/web/components/ui/dialog.tsx` | Retain existing token-based primitive markup/props/accessibility; conflict only changes classes, with merged behavior preserved. |
| `apps/web/components/ui/sheet.tsx` | Retain existing token-based primitive markup/props/accessibility; conflict only changes classes, with merged behavior preserved. |
| `apps/web/components/ui/tabs.tsx` | Retain existing token-based primitive markup/props/accessibility; conflict only changes classes, with merged behavior preserved. |
| `apps/web/components/workspace.tsx` | Union cached/event-patched paginated workspace and Origin coding/app-link/details/library panels. One live desktop; v2 routines, coding, learning, bio, share menu, teaching, budgets, library, and legacy/new tab access remain reachable. |
| `apps/web/lib/api.ts` | Keep v0.5 full routine/run normalization alongside the automatically merged Origin helpers. |
| `apps/web/lib/avatar-motion.ts` | Export both pose/preview and shared-frame APIs; pure shape geometry moves to avatar-shapes.ts. |
| `apps/web/lib/message-blocks.ts` | Union file sizes, video and coding-job blocks with resume/compaction blocks and expanded memory actions. |
| `apps/web/lib/types.ts` | Union all message, workspace, job, peer, routine and resume fields; canonical aiConnected replaces user-facing provider slots, with reply aliases retained. |
| `apps/web/next.config.ts` | Union hardened image policy and v0.5 import optimization. |
| `apps/web/package-lock.json` | Byte-for-byte v0.5-local lock retained. Orchestrator must regenerate/install against the dependency union; retained lock audit is zero. |
| `apps/web/package.json` | Union scripts/dependencies at the higher version; do not regenerate locks or install. Avatar TS runner uses its existing transpiling hook for the available Node runtime. |
| `deploy/Caddyfile.production` | Keep admin hostname plus loopback-published 8081 listener; preserve production CSP, streaming, allowlist and hidden internal routes. |
| `deploy/Caddyfile.test` | Same union as development edge, preserving opt-in test routes. |
| `docker-compose.yml` | Keep v0.5 isolation and generated-stack mechanisms; retain admin service and configurable loopback-only admin publication. |
| `services/agent/Dockerfile` | Keep pinned Wolfi base and requirements, install ffmpeg with its package manager, copy every Origin/v0.5 worker module including coding jobs. |
| `services/agent/worker.py` | Union coding-job reporting, concise app-link/answer prompt, approval-signal/brief instructions, auth/browser context and poison-test behavior. |
| `services/computer/Dockerfile` | Keep pinned requirements mechanism and complete v0.5 desktop/isolation/image tooling; add Pillow/httpx/websockets to requirements. |
| `services/mock-openrouter/planner.py` | Union deterministic app guide/replies/reactions with video/routine/peer/plan/test-gate scenarios. |
| `tests/e2e/acceptance.spec.ts` | Union old/new panel access and tab coverage, keep v0.5 explicit reaction interaction; canonical nested-library helper retained. |
| `tests/e2e/admin-app.spec.ts` | Keep full Origin settings assertions, v0.5 portable screenshots/admin opt-in and signed-out fixture handling; assert AI-model management exists. Obsolete no-billing text is superseded by the billing union. |
| `tests/e2e/mobile.spec.ts` | Union Details/Library/Computer and v0.5 tab coverage. |
| `tests/e2e/package-lock.json` | Byte-for-byte v0.5-local lock retained. Orchestrator must regenerate/install against the dependency union; retained lock audit is zero. |
| `tests/e2e/package.json` | Union scripts/dependencies at the higher version; do not regenerate locks or install. Avatar TS runner uses its existing transpiling hook for the available Node runtime. |
| `tests/e2e/playwright.config.ts` | Union desktop spec matches and separate admin project; keep isolated-stack imports/setup, headers and all mobile projects. |
| `tests/e2e/security.spec.ts` | Keep merged security checks and fix the combined helper parameter name; retain draft behavior for non-task sends. |
| `tests/e2e/visual.mjs` | Keep complete Origin navigation list; compatible Overview/Routines/Files aliases remain available. |
| `tests/integration/test_reliability_v04.py` | Retain mock-without-key and key save/rotation checks using safe public status; retain managed-provider bootstrap handling and bot cleanup fixture. |
| `tests/unit/ReliabilityTests.cs` | Use canonical v0.5 safe error vocabulary while continuing to test legacy inputs. |

## Verification and handoff

Final results:

| Check | Result |
| --- | --- |
| API build | Passed; 0 errors, 13 existing nullable/package warnings |
| .NET unit suite | 789 passed, 25 skipped, 814 total; includes admission/fallback, migration manifest, account, policy, reply and reliability coverage |
| Web lib `*.test.mjs` | 80 passed, 0 failed |
| Web lib `*.test.ts` with existing transpiling hook | 21 passed, 0 failed |
| Python unit suite excluding `test_computer_network.py` | 456 passed, 1 skipped, 0 failed; one existing Starlette warning |
| Admin tsc | Passed using a temporary link to existing web dependencies; link removed after check |
| Web tsc | Exactly 3 missing-module errors: `@xterm/xterm`, `@tanstack/react-virtual`, `web-vitals`; no other diagnostics |
| E2E static checks | 73 TypeScript files; zero parse or undefined/duplicate declaration diagnostics. This is not browser execution. |
| npm audit of retained locks | Web 0, admin 0, e2e 0 vulnerabilities |
| Conflict-marker and whitespace scans | Zero markers in apps/services/db/tests/scripts or root/deploy configuration; git diff --check clean |

Browser, container-image and PostgreSQL migration execution require the orchestrator's isolated environment; none were run against the live stack. The PostgreSQL-backed test bodies require TEST_PG_DSN, which is explicitly unset in final .NET verification. The browser package is absent. Web typechecking is limited only by three absent shared-install packages; no declarations were stubbed and no dependencies were installed.

Handoff: orchestrator stages the 70 resolved paths and SQL renames, regenerates/install dependencies in apps/web, apps/admin and tests/e2e, then reruns full tsc, audit, isolated browser/DB/migration/container checks and commits. No git metadata operations were attempted here. See `/workspace/ui-int/NEEDS-NPM.md` for package commands and missing-module notes. Temporary check logs and the temporary admin node_modules link were removed; the progress log is `/workspace/ai-teammates-live/wt-logs/ui-integrate.md`.
