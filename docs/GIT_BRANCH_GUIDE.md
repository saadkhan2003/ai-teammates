# Git branches, history, and snapshots

Initial repository ref inventory checked 2026-10-25. The checkout at that capture
was on local `main` at `0a8a3faa3b8e32ccf078900f974b047e93279f85`; it tracks
`origin/main`. The remote is
`https://github.com/saadkhan2003/ai-teammates.git`. The repository is not shallow.
That original snapshot had 52 remote branch names, one local branch, 49 checkpoint
tags (48 lightweight and one annotated), one worktree, no stashes, and no submodules.
A follow-up GitHub branch-name check at 2026-10-25 12:28 UTC returned 58 names;
the six added `codex/*` branches are listed below. The original table remains the
52-ref snapshot. The branch-name API did not return commit IDs; the added branch
SHAs below came from the corresponding pull request heads at that check. Refresh
the refs before making decisions from this dated inventory.

## How to read this history

`main` is a reconstructed v0.3 baseline, not the newest product state. All 52
remote branch tips in the original snapshot descended from it. The follow-up check
confirmed the six added `codex/*` tips also descend from `main`. `origin/ui-integrate`
is the broad integration line: at the original capture it had 423 commits reachable
after `main` and contained the exact tip commits of 50 of 52 refs. At the follow-up
check its tip was unchanged and contained 50 of 58 refs. The eight absent tips are
`briefs-v1-pre-rebase`, `v04w/lr-1`, and the six added `codex/*` branches. Those six
are one commit ahead of their PR base; five are based directly on `ui-integrate`,
while `codex/repo-onboarding` is based on `main`. These are ancestry facts; similar
code may have been reworked or copied into the integration line. They do not prove
behavioral equivalence.

Most branches are retained workstream heads, not unrelated product versions.
Branch-only commit counts below mean `git rev-list origin/main..origin/<branch>`;
they include shared commits and merges, so they are not a count of unique feature
changes. The last-column message is the tip commit subject, which is useful to
identify the final refinement but does not describe the entire branch.

The main version progression is:

```text
main (v0.3 reconstructed baseline)
  └─ v0.4 work and hardening: v0.4-codex / v04-bc / v04-merge
       └─ v0.5-local
            └─ ui-integrate (UI, account, skills, pages, widgets, video and fixes)
```

This is a readable summary rather than the complete merge graph. The `arch/*`,
`sp-*`, UI/PR, and `v04w/*` names preserve the feature work that fed into later
integration commits. For ancestry checks use the exact commits, not branch names:

```sh
git merge-base --is-ancestor origin/v0.5-local origin/ui-integrate
git log --graph --decorate --oneline --all
git diff origin/main...origin/ui-integrate
```

## Branch inventory

`In ui-integrate` means the branch tip is an ancestor of that integration tip.
“Yes” means the exact commit is present in its history. “No” means the tip is not
in that history and deserves a code comparison before assuming its work is covered.

### Baseline and integration lines

| Branch | Tip | Commits after main | In ui-integrate | Tip subject |
|---|---:|---:|:---:|---|
| `main` | `0a8a3faa3b` | 0 | yes | v0.3 baseline (reconstructed from Origin) |
| `v0.4-codex` | `6a8c101ff3` | 223 | yes | v0.4 E2E/security scans stream database rows to avoid OOM |
| `v04-bc` | `6a8c101ff3` | 223 | yes | Same commit as `v0.4-codex` |
| `v04-merge` | `74b951b854` | 203 | yes | v0.4 round-budget, chaos-fixture and computer-cleanup fixes |
| `v0.5-local` | `6340659013` | 306 | yes | v0.5 verification/performance/memory log |
| `ui-integrate` | `5dbbbc454f` | 423 | yes | Cloud UI aligned video watch and computer-card E2E behavior |
| `briefs-v1` | `8ec42ec358` | 238 | yes | Integration fix: deleting a desk bot removes its Chrome profile |
| `briefs-v1-pre-rebase` | `47bd4f780a` | 218 | **no** | Structured task briefs, learning notes, and bot-private coding roots |

`v0.4-codex` and `v04-bc` are aliases for the same commit. `v0.5-local` is a
parent of `ui-integrate`, and the later integration history includes account pages,
the bot-app awareness work, skills v2, rich widgets, pages, and video. The
`briefs-v1-pre-rebase` tip has four commits absent from `ui-integrate`, including
approval-signal learning notes and the structured brief/steering/eval work. The
integrated tree has brief-related code and migrations, but do not treat the old
branch as a redundant pointer without comparing those files.

### Architecture, security, companion, and test work

| Branch | Tip | Commits after main | In ui-integrate | Tip subject |
|---|---:|---:|:---:|---|
| `arch/base` | `2f3ecd4a12` | 39 | yes | Isolation docs renamed to per-bot isolation |
| `arch/c1` | `304846acbf` | 40 | yes | Window router rejects symlinked token directories |
| `arch/c2` | `8bacb12863` | 40 | yes | PTY/tmux terminal service, ticket API, xterm component |
| `arch/c3` | `983df04bbf` | 41 | yes | Proxy relay, policy refresh/audit, per-bot UID firewall rules |
| `arch/c4` | `2652ad9674` | 40 | yes | Teach endpoints, upload/queue, approval-gate hardening |
| `arch/c5` | `3d2da49792` | 41 | yes | WebSocket close grace, tab transfer, shell/CDP fencing, migration 021 |
| `arch/c6` | `2bbbfc43b4` | 40 | yes | Signed directory, API signing, private browser lifecycle |
| `arch/companion` | `6962210313` | 71 | yes | Device command WebSocket routes and migration 032 |
| `arch/gaps` | `db83eb3ce4` | 119 | yes | Playwright gap pass recorded as 54/54 |
| `arch/integration` | `8fb1fa760e` | 59 | yes | Integration of c5 with lease migration 021 |
| `arch/resume` | `5d45760554` | 98 | yes | Resume/worktree suite status |
| `arch/rules` | `1dfa976423` | 76 | yes | E2E route and assertion fixes |
| `arch/skills` | `d49f55effc` | 70 | yes | Skills library, load/write tools, revisions, audit and UI |
| `arch/video` | `20189df33f` | 70 | yes | Video tools, transcription, summaries, cache, cards and tests |

### UI and pull-request references

These are retained source and locally verified heads for UI changes described as
PRs 6–11 in commit subjects. Their presence here does not say whether a GitHub PR
is currently open, merged, or otherwise active. The integration history contains
each listed tip.

| Branch | Tip | Commits after main | In ui-integrate | Tip subject |
|---|---:|---:|:---:|---|
| `origin-pr/bot-app-awareness-a02f` | `fc982286d3` | 13 | yes | Captured PR #6 source ref |
| `origin-pr/grok-chat-ui-2a3b` | `59a5dbc127` | 14 | yes | Captured PR #7 source ref, includes #8–#10 |
| `origin-pr/grok-chat-ui-mb11` | `d070a694d9` | 13 | yes | Shared base for PR #7 and #11 |
| `origin-pr/ui-account-pages` | `d4aa836840` | 14 | yes | Captured PR #11 source ref |
| `pr/bot-app-awareness-a02f` | `3096311939` | 13 | yes | Locally verified PR #6 head |
| `pr/grok-chat-ui-2a3b` | `c834f2abf0` | 19 | yes | Locally verified PR #7 head |
| `pr/ui-account-pages` | `658791e5de` | 19 | yes | Locally verified PR #11 head |
| `pr/ui-avatar-motion` | `72678aa8e1` | 14 | yes | Shared avatar animation clock (PR #8) |
| `pr/ui-chat-messages` | `282a99cd58` | 14 | yes | Chat message column styling (PR #9) |
| `pr/ui-right-panel` | `a9d3f7bc56` | 15 | yes | Info panel and computer view styling (PR #10) |

### Product feature branches

| Branch | Tip | Commits after main | In ui-integrate | Tip subject |
|---|---:|---:|:---:|---|
| `account-v1` | `677f803802` | 241 | yes | Nested dialog overlay and modal layering |
| `pages-v1` | `3bda91c99b` | 239 | yes | Provider-neutral task error copy for Pages |
| `rich-ui` | `ebeb4dd622` | 237 | yes | Shared chart colors, static render and themed tooltips |
| `skills-v2` | `5661dae213` | 242 | yes | Skills settings rows and pane layout |
| `video-v1` | `8eced03f7f` | 241 | yes | Provider-neutral error handling in video tests |
| `v1-hallmark-base` | `5c8013574e` | 224 | yes | Shared base UI quality sweep |

### Performance, AI operations, and computer speed work

| Branch | Tip | Commits after main | In ui-integrate | Tip subject |
|---|---:|---:|:---:|---|
| `sp-ai` | `4634e92973` | 219 | yes | AI fallback/breaker, capability, spend/key/privacy controls and migration 045 |
| `sp-jobs` | `2461e229c2` | 229 | yes | Settings/secrets loading boundary |
| `sp-p0` | `0e5da7b623` | 215 | yes | TTFT/usage telemetry, RUM/admin API, k6 and bundle budget |
| `sp-p12` | `d31ab16120` | 219 | yes | Optimistic chat, prompt/session caching, streaming, shared SSE and patches |
| `sp-p3` | `9e6eec0e3b` | 220 | yes | Composer prewarm and adaptive CDP readiness |
| `sp-p4` | `82052790b3` | 220 | yes | Loading skeletons, sidebar prefetch and lazy dialogs |
| `sp-p4v` | `768a75a2cf` | 227 | yes | Virtualized chat and lazy UI for smaller initial bundles |
| `speed-v1` | `c0ae89a4c0` | 246 | yes | Workspace sync timestamp precision/redaction fix |

### v0.4 workstreams

| Branch | Tip | Commits after main | In ui-integrate | Tip subject |
|---|---:|---:|:---:|---|
| `v04w/lib-1` | `03f46467b2` | 56 | yes | Merged v0.4 into library workstream 1 |
| `v04w/lib-2` | `95c65bffa2` | 61 | yes | Merged v0.4 into library workstream 2 |
| `v04w/lib-3` | `ca14784be5` | 64 | yes | Merged v0.4 into library workstream 3 |
| `v04w/lr-1` | `cceccfb1a2` | 69 | **no** | Merged memory work into long-run resume work |
| `v04w/mem-1` | `647fa06140` | 67 | yes | Memory store/guard, tools, REST, role/instructions, migration 027 |
| `v04w/n-panel` | `b30247d2fa` | 54 | yes | Routine history, pause/resume, test, edit and delete drawer |

`v04w/lr-1` has two commits not in the integration history: a checkpoint ledger,
cumulative budgets, resume policy, and next-message resume. The integrated branch
does include other long-run-resume work (migrations 028–033), so compare the actual
worker/API behavior before judging the unmerged commits.

### Follow-up Codex branches found on GitHub

These six names were absent from the original 52-ref inventory. The GitHub PR API
reported each associated PR open and mergeable at 2026-10-25 12:28 UTC; that state
can change independently of this document. `In ui-integrate` refers to exact tip
ancestry, not whether the PR should be merged.

| Branch | Tip | PR | Base | In ui-integrate |
|---|---:|---:|---|:---:|
| `codex/admin-spend-caps` | `e522981a2a` | [#3](https://github.com/saadkhan2003/ai-teammates/pull/3) open | `ui-integrate` | no |
| `codex/docs-history-context` | `1843883b91` | [#6](https://github.com/saadkhan2003/ai-teammates/pull/6) open | `ui-integrate` | no |
| `codex/docs-integrated-audit` | `a0db2b86fc` | [#4](https://github.com/saadkhan2003/ai-teammates/pull/4) open | `ui-integrate` | no |
| `codex/docs-shipped-status` | `35ebc5cd86` | [#5](https://github.com/saadkhan2003/ai-teammates/pull/5) open | `ui-integrate` | no |
| `codex/repo-onboarding` | `85b8d4c057` | [#1](https://github.com/saadkhan2003/ai-teammates/pull/1) open | `main` | no |
| `codex/resume-quota-features` | `7768c93718` | [#2](https://github.com/saadkhan2003/ai-teammates/pull/2) open | `ui-integrate` | no |

The current PR links and branch bases are a review snapshot, not merge advice.
Each PR should be reviewed against its own base; in particular, PR #1 and this
branch-inventory follow-up build on the onboarding documentation rather than on
`ui-integrate`.

## What ui-integrate contains

This is the most complete integrated snapshot among the refs inspected, not a
claim that it is the production deployment or the team's chosen release branch.
Its tip README describes v0.4 with a companion CLI and mock model; its source tree
contains migrations `001`–`055` and `057`–`063` (there is no `056` file in the
tree). Relative to the main baseline it adds, among other things:

- device pairing and companion commands; computer windows, desktop leases,
  takeover fencing, tickets and live job execution/logs;
- long-running task resume/budget rules, richer routines, a skill library and v2
  skills, memories/lessons, structured task briefs and approval signals;
- video analysis/transcription and video-aware cards, plus Pages and sharing;
- model/speed telemetry, AI controls, usage/credits, support, billing/account
  pages, admin console, richer UI widgets and chat updates;
- broad unit, integration, E2E and workstream-specific fixes, with merge notes
  explaining several cross-branch conflict resolutions.

For exact implementation detail, use `git show origin/ui-integrate:<path>` or
inspect the migration list with `git ls-tree -r --name-only origin/ui-integrate`.
The checked-out files remain `main`; branch documentation must not be mistaken for
code currently present in the working tree.

The integration adds several major source areas on top of the baseline map in
`REPOSITORY_GUIDE.md`:

| Area | Main new entry points on `ui-integrate` |
|---|---|
| API account and admin | `apps/api/AccountRoutes.cs`, `AccountBilling.cs`, `AccountSecurity.cs`, `AdminConsole.cs`, `AiAdmin*.cs`, `AiModelRegistry.cs`, `AiControls.cs` |
| Task briefs and learning | `apps/api/BriefRoutes.cs`, `BriefStore.cs`, `Briefs.cs`, `ApprovalSignals.cs`, `MemoryLearning.cs`, `LearnedRoutes.cs` |
| Computer control and jobs | `apps/api/ComputerWindows.cs`, `DesktopLeases.cs`, `OneTimeTickets.cs`, `ComputerJobs.cs`, `JobLogStream.cs`, `CodingWork.cs`, `CodingTools.cs` |
| Library, pages and video | `apps/api/Library*.cs`, `Pages.cs`, `apps/api/Video*.cs`; worker-side `services/agent/video_analysis.py` |
| Model delivery and speed | `apps/api/ModelStream.cs`, `AiControlledGateway.cs`, `PromptCaching.cs`, `AiUsage.cs`, `AiWaiters.cs`; worker-side `parallel_reads.py` and updated `worker.py` |
| Computer security | `services/computer/src/egress/` (policy, proxy, relay, firewall, SSRF), `window_router.py`, `private_browser.py`, `desktop_fencing.py`, `tickets.py`, `pty.py`, `vnc_broker.py` |
| User and operator surfaces | New standalone `apps/admin/`, `apps/companion/`, account/settings routes and widget components under `apps/web/` |
| Schema and validation | `db/011`–`055`, `057`–`063`; new `tests/unit`, `tests/integration`, `tests/e2e`, `tests/load`, and `evals/briefs` coverage |

The API remains the authority for task leases, account ownership, model access,
policy and persistence. The Python worker gained resumable/cancellable jobs,
compaction, parallel reads, video and widget tools, and richer task context. The
computer gained multiple desktop windows, tickets, a terminal, private-browser
flows and an egress relay/firewall layer. The web product adds account/billing/
support, library/pages, skills v2, jobs, video and admin views. The companion is
a separate paired-device client; it is not a second API or compute backend.

## Tags, refs, and worktree state

There are 49 tags. Forty-six `cp-2026-10-25-0410/*` tags preserve branch
checkpoints, and three `cp-2026-10-25-pre-redesign*` tags mark pre-redesign
snapshots. They are checkpoint labels, not release/version tags. Several checkpoint
tags point behind their branch's current tip, so resolve the tag directly before
using it. The three pre-redesign tags point to `700851a`, the `ui-integrate` tip,
and a separate v0.5 merge snapshot respectively. Forty-eight tags are lightweight;
`cp-2026-10-25-pre-redesign-v05` is the one annotated tag.

At the original capture there was one local branch (`main`) and one worktree at the
repository root, no stashes or submodules, and `origin/HEAD` pointed to `origin/main`.
The only configured remote was `origin` (fetch and push URL were the GitHub HTTPS
URL). During the follow-up audit, all 58 GitHub branch names were fetched into local
remote-tracking refs and the inventory update was created on
`codex/docs-branch-inventory`; these additions are later than the original
worktree/ref count. Local `refs/codex/turn-diffs/*` are Codex-managed
capture/checkpoint refs included by `git rev-list --all`; they are not product
branches. The local reflog records the clone on 2026-10-25 and does not provide
earlier checkout history.

After the 12:28 UTC 58-name snapshot, this inventory follow-up was published as
[`PR #7`](https://github.com/saadkhan2003/ai-teammates/pull/7) from
`codex/docs-branch-inventory` to `codex/repo-onboarding`. A new GitHub check then
returned 59 branch names, including that follow-up branch; it is intentionally not
part of the dated 58-name comparison above.

Testing evidence has a narrower scope than the branch inventory. In this session,
the 46-test Python unit suite and configuration/source checks described in
`REPOSITORY_GUIDE.md` were run against checked-out `main`. The later branches contain
many more unit, integration, E2E, load and eval fixtures. Their commit/checkpoint
notes mention successful focused checks, but those branch suites were not run here;
the inventory establishes commit ancestry, not test status or runtime readiness.

Useful commands:

```sh
git status --short
git branch -avv
git show-ref
git tag -n
git worktree list --porcelain
git log --graph --decorate --oneline --all
git rev-list --left-right --count origin/main...origin/ui-integrate
git diff --stat origin/main...origin/ui-integrate
git merge-base --is-ancestor origin/briefs-v1-pre-rebase origin/ui-integrate
```

The original 52-ref inventory did not fetch, check out, reset, rebase, or modify
branches. This follow-up audit fetched the current remote refs and updated the
dated inventory; it did not merge any branch or pull request.
