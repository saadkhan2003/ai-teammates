# Video v1 merge into v0.4 + Skills v2

Historical conflict-resolution record for the `v04-bc` worktree. The statement that the index remained unmerged describes the state before the merge commit; it is not the current repository index or merge status.

Working tree: `wt/bc`, branch `v04-bc`, starting/current HEAD
`5acf9ebc17acb9b626b1a9ff547536856cf5751e`. File conflicts are resolved;
the index remains unmerged until the orchestrator stages the resolutions.
No git staging, commits, branch changes, Docker commands or paid model calls
were performed.

## Conflict resolutions

| File | Resolution |
|---|---|
| `WT-PROGRESS.md` | Preserved every v0.4, Skills v2 and Video v1 history entry; appended merge/verification progress. |
| `apps/api/Dockerfile` | Kept migrations 001–041 and builtin skills; added 042 video; kept one runtime ENV/EXPOSE block. |
| `apps/api/Platform.cs` | Kept the locked, transactional linear migration manifest; added 042 and the real-provider model fallback. |
| `apps/api/Routes.cs` | Combined video result/message metadata with atomic fenced feedback consumption and attempt logging; retained preexec, memory and skill routes. |
| `services/agent/Dockerfile` | Kept resume, compaction, snapshots and browser-auth modules; added ffmpeg and video analysis. |
| `services/agent/worker.py` | Kept resume, lease-loss cancellation, poison hook, skills and preexec; video processing now starts through fenced server Execute authorization. |
| `tests/unit/V03Tests.cs` | Kept file-transfer/DLP tests and video schema/model-tool tests. |

## Semantic reconciliation

`watch_video` and `ask_video` coexist with skill and memory schemas and are
registered as built-in Read tools. Preexec honors allow/ask/deny and fails
closed. Execute validates schema, binds the bot to the running task/epoch,
consumes required approval and records the invocation in the audit/step path.
It creates a video session fixing tool, source, task, bot, epoch and approved
risk class. Every video bridge operation requires that session and rechecks
PolicyGate. A stale lease, substituted bot/session or revoked Read policy blocks
the bridge. Source payloads cannot replace the session's authorized source.
Library owner/bot/DLP checks and confined workspace reads remain authoritative.
Skills continue through their existing fenced Execute dispatch.

Cache identity includes owner, bot, source, content hash and a fingerprint of
the effective summary/STT models, provider and worker preprocessing settings.
Persisted compact cards omit raw transcript/frames and rehydrate across worker
resume and transcript compaction. Video text is marked as untrusted planner
context; cached/published text is redacted. Progress after actual preprocessing
work renews the existing bounded watchdog window, and cancellation kills/reaps
ffmpeg. Sampling enforces the frame cap in each minute, including partial final
minutes; sparse videos still split summary inputs into five-minute ranges.

The API still resolves `secret://openrouter/default`; worker requests never
carry the owner's key. No isolation, desktop-fencing or credential-domain
restrictions were relaxed.

## Migration mapping

`db/095_video_analyses.sql` → `db/042_video_analyses.sql`.
This migration creates the private analysis cache and authorized video sessions.
There are no other incoming 09x video migrations. SQL files 001–041 remain
byte-for-byte identical to HEAD. Both manifests cover every SQL file once in
linear 001–042 order; `MigrationManifestTests` passed in the full .NET suite.
See [MIGRATIONS_V04.md](MIGRATIONS_V04.md) for upgrade reconciliation rules.

## Default-model changes

The real default/recommended bot model is `anthropic/claude-haiku-5.5`.
Explicit overrides remain supported. Mock-provider fallback and compose/test
`MODEL_PLANNER=mock/planner` remain intact. Video summaries inherit the planner
unless `VIDEO_SUMMARY_MODEL` overrides it. Embedding and Whisper models are
separate and unchanged.

Every implementation/example/guidance location changed:

- `.env.example`: opt-in production planner/video example; active mock values retained.
- `apps/api/Platform.cs`: real-provider fallback constant and provider-aware selection.
- `apps/web/components/workspace.tsx`: model-setting placeholder.
- `tests/unit/ProviderContractTests.cs`: example model and wire-model assertion.
- `tests/unit/VideoToolsTests.cs`: new real/mock/override default regressions.
- `docs/DECISIONS_DEFAULTS.md`: owner-confirmed real default and mock distinction.
- `docs/V0_4.md`: default-model section and Video v1 feature summary.
- `docs/VIDEO_V1.md`: real summary fallback and mock behavior.
- `docs/V0_5_PLAN.md`: added dated default-model note; historical measurements unchanged.
- `evals/eval_real.py`: production model configuration guidance only; never executed.
- `scripts/install.sh`: production model guidance; local installer still uses mock configuration.
- `README.md`: real-eval configuration guidance.

No seed SQL contained a real model default to replace. Progress and this report
also record the change. No actual `.env` file was read or edited.

## Validation

All suite commands ran from this worktree. The .NET environment exported
`PATH=/workspace/dotnet:$PATH`, `DOTNET_ROOT=/workspace/dotnet` and
`DOTNET_CLI_TELEMETRY_OPTOUT=1`.

| Command | Passed | Failed | Skipped |
|---|---:|---:|---:|
| `/workspace/ai-teammates-live/wt-logs/heavy.sh env -u STACK -u ISOLATION_CHAIN dotnet test tests/unit -nologo -v q` | 487 | 0 | 5 |
| `/workspace/ai-teammates-live/wt-logs/heavy.sh env -u STACK -u ISOLATION_CHAIN python3 -m pytest -q tests/unit --ignore=tests/unit/test_computer_network.py` | 346 | 0 | 1 |
| `/workspace/ai-teammates-live/wt-logs/heavy.sh node --test apps/web/lib/*.test.mjs` | 48 | 0 | 0 |
| `/workspace/ai-teammates-live/wt-logs/heavy.sh apps/web/node_modules/.bin/tsc --noEmit -p apps/web` | 1 check | 0 | 0 |
| `python3 -m py_compile tests/integration/*.py` | 34 files | 0 | 0 |
| `bash -n scripts/install.sh` | 1 check | 0 | 0 |

The five .NET skips require isolated `TEST_PG_DSN`. The Python skip requires
local PostgreSQL binaries and an isolated harness; those binaries are absent.
The forbidden computer-network unit file was excluded, and
`tests/integration/test_computer_network.py` was never executed. Eight existing
BotMessaging nullable compiler warnings and one Starlette/httpx deprecation
warning remain.

Early verification caught a new-test namespace collision and an incorrect
hard-deny test assumption; both were corrected before these final passes.
Working-tree conflict-marker and diff whitespace scans are clean.
Verification logs are ignored `.video-*.log` files at the worktree root.

## Pending external validation

Docker image builds, live mock-stack integration, chaos and Playwright are
unrun because Docker is unavailable in this sandbox. The authored video tests
include session authorization, owner/bot/epoch privacy, cache persistence,
policy revocation and resume-card checks for the orchestrator. No live stack
was accessed. Upstream transcription provider routing remains the documented
Video v1 uncertainty: pinning `provider.order`/`allow_fallbacks` is not verified
against a real provider. No new functional failures remain in executed checks.

Final merge commit SHA is pending the orchestrator; current HEAD is unchanged.
