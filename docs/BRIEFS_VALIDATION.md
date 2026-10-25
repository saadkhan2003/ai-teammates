# Briefs backend validation

Historical checkpoint from the `briefs` worktree (2026-10-24). The backend and worker changes were later incorporated into the integrated tree; the “uncommitted” and sibling-run statements below describe that checkpoint, not current repository state. Test results are limited to the commands recorded here.

Backend/worker/eval work is complete in the `briefs` worktree. Frontend and Playwright files belong to the sibling run; this backend run did not edit them. Changes are uncommitted for the orchestrator. Observed HEAD: `f1e5b5391ffd4900da44c4f7de13c97ae2f275b3` (the sibling UI commit); a final backend commit SHA does not exist yet.

Latest checks (2026-10-24):

| Check | Passed | Failed | Skipped | Result |
| --- | ---: | ---: | ---: | --- |
| Related C# tests, including real PostgreSQL API/storage/privacy/steering tests | 127 | 0 | 0 | Passed |
| Related Python worker/guard/compaction/eval tests | 59 | 0 | 0 | Passed |
| Web Node tests | 49 | 0 | 0 | Passed |
| Web TypeScript | — | 0 | — | Exit 0 |
| Seven changed Python runtime/integration/eval modules, py_compile | 7 | 0 | 0 | Passed |
| git diff --check | — | 0 | — | Clean |

The C# command used the user's isolated TEST_PG_DSN at 127.0.0.1:55433; credentials are intentionally omitted here. Each database fixture created and dropped its own test database. No Docker connection or real provider was used.

```sh
export PATH=/workspace/dotnet:$PATH DOTNET_ROOT=/workspace/dotnet DOTNET_CLI_TELEMETRY_OPTOUT=1
# TEST_PG_DSN set to the user-provided isolated test DSN before this command.
env -u STACK -u ISOLATION_CHAIN dotnet test tests/unit -nologo -v q --filter 'FullyQualifiedName~Brief|FullyQualifiedName~PolicyTests|FullyQualifiedName~CodingWorkTests|FullyQualifiedName~SkillLibraryTests|FullyQualifiedName~MigrationManifestTests|FullyQualifiedName~Routine'
python3 -m pytest -q tests/unit/test_briefs_worker.py tests/unit/test_brief_evals.py tests/unit/test_guard.py tests/unit/test_run_guard.py tests/unit/test_skill_tools.py tests/unit/test_compaction.py
apps/web/node_modules/.bin/tsc --noEmit -p apps/web
node --test apps/web/lib/*.test.mjs
python3 -m py_compile tests/integration/test_briefs.py evals/briefs/judge.py evals/briefs/run_real.py services/agent/worker.py services/agent/guard.py services/agent/compaction.py services/mock-openrouter/planner.py
git diff --check
```

The required full-suite commands were attempted, but **neither suite started**:

```sh
env -u STACK -u ISOLATION_CHAIN /workspace/ai-teammates-live/wt-logs/heavy.sh dotnet test tests/unit -nologo -v q
/workspace/ai-teammates-live/wt-logs/heavy.sh python3 -m pytest -q tests/unit --ignore=tests/unit/test_computer_network.py
```

`heavy.sh` opens `/workspace/ai-teammates-live/wt-logs/locks/slot-{1,2}.lock` with write redirection. That directory is mounted read-only in this sandbox, producing “Read-only file system” and “Bad file descriptor” before starting either test process. Both waiting wrappers were terminated. Full-suite pass/fail/skip counts are therefore unavailable, and no full-suite pass is claimed. Permission was requested for a local adapter holding exclusive locks on the **same shared lock-file inodes** through read-only descriptors; no adapter was used without that approval. The full suites remain for the orchestrator unless that permission arrives.

Live integration/chaos/Playwright and Docker rebuilds remain orchestrator-only because Docker is unavailable and prohibited in this sandbox. `tests/integration/test_briefs.py` was authored and compiled; its two live tests were not executed. The sibling run owns the Playwright brief-card spec. The firewall-changing integration network test and the paid real eval runner were not run, as required.

Early focused checks caught a stale rendered fixture, an optional-review response-type compile issue, and an existing routine SQL timestamp bug with the owner's default Asia/Karachi zone. All were corrected and covered by the latest passing checks. The routine fix converts SQL-bound timestamps to UTC while preserving schedule timezone semantics. API compilation retains eight existing nullable warnings in BotMessaging; no new warning remains.

Local ignored logs: `test-results/briefs/dotnet-related.log`, `python-related.log`, `node.log`, `tsc.log`. Product/schema/API details: [BRIEFS.md](BRIEFS.md).
