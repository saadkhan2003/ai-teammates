# Long-running work: limits, interruptions, auto-resume — findings and a design for AI Teammates

Status: historical design and implementation reference. The integrated tree includes cumulative budgets, durable resume state, lease recovery, compaction, retry limits, user-visible notices/cards, and chaos coverage; see [`LONG_RUN_RESUME_IMPLEMENTATION.md`](LONG_RUN_RESUME_IMPLEMENTATION.md), `apps/api/ResumeBrief.cs`, `apps/api/Reliability.cs`, `services/agent/worker.py`, and `apps/web/components/resume-card.tsx`. The findings and gap list below are the original design snapshot, not a current implementation checklist. Recheck any remaining design item against source and tests. Day counts are **estimates**, not measurements.
Tags: **[verified]** = read on a fetched page, in this repo, or in a tool result this session (source named). **[secondary]** = only seen in a search-result summary, page not read. **[inferred]** = reasoned from verified facts. **[guess]** = a number or choice I picked and have not tested.
Grok Bot does not publish how its runtime limits, kills or resumes work. Everything about *how it does it* is inferred.

## 0. Summary (read this first)

- Nobody documents one universal "max run time". Limits come from four independent places: the **session/credential lifetime**, the **model context window**, **per-run budgets** (steps, time, money), and **idle/sleep policy**. Products survive them the same way: keep state **outside** the process (database, transcript file, git), **detect** death (heartbeat/lease), **restart** a new worker from the last durable state, and **shrink** context by summarising instead of replaying.
- Our observed "interrupted roughly every hour or ~1,000–1,500 tool calls" is **not explained by anything public**. A one-hour credential/session TTL is plausible (see 1.1, Cursor/Vercel) but unproven. Cheap way to find out: log wall-clock and tool-call count at each interruption (section 6, step 0).
- AI Teammates already has the hard half: DB task queue, 20 s lease with 5 s heartbeat, epoch fencing, stall watchdog, plan items, per-step transcript, outbound idempotency, computer-recovery resume. It is missing the soft half: **cumulative budgets, a resume brief, context compaction, a no-progress breaker, and any user-visible "resumed" notice.** Details in section 3.
- Recommendation: build section 4 in the order in section 6. About **10–13 engineer-days [guess]**, 7–9 calendar days with parallel agents [guess]. Step 0 (a supervisor for our own build workers) takes half a day and helps today.

## 1. Findings: how others handle it

### 1.1 Max run time, idle timeouts, interruptions

| Product | What is documented | Tag / source |
|---|---|---|
| Cursor Cloud Agents | The web "Long-running" mode, its time-limit pill and the team setting were **removed on the week of Sep 21, 2026**; web agents always run in standard mode. Docs state **no fixed maximum duration**. For long work they point to `/goal` in the app. | [verified] https://cursor.com/docs/release-notes/cloud-agents , https://cursor.com/docs/cloud-agent/settings |
| Cursor, token lifetime | In Vercel's reference setup, the worker token Cursor issues **expires after one hour and cannot refresh itself**, so it "sets how long an uninterrupted session can run"; plan limit 45 min (Hobby) / 24 h (Pro, Enterprise). Cursor release notes say agents now "refresh GitHub tokens during long runs instead of hitting expired tokens mid-run". A one-hour credential TTL is a documented cause of hourly cut-offs in a Cursor-based setup. | [verified] https://vercel.com/docs/sandbox/ecosystem/cursor , release notes above |
| Cursor, recovery | If a pool machine goes offline the agent "waits for that same machine to come back and continues there, and moves to another machine only after that". Agents "recover from a lost machine connection by reconnecting on the next step". An agent stuck behind a queued run "accepts follow-ups again after an hour". Moved environments: agent shows "Reconnecting to your environment", retries on its own, keeps files. | [verified] release notes (several weekly entries, Sep–Oct 2026) |
| Cursor `/goal` | Persistent objective; keeps starting turns while the session is open, until done; Ctrl+C pauses; sending a message resumes. No independent completion check documented. | [secondary] https://cursor.com/docs/cli/reference/slash-commands |
| OpenAI Codex Cloud | Help Center states **no configurable max task duration**. Tasks continue while your computer sleeps; saved VM state is recoverable **up to 7 days** after the last turn start or resume; "commit important work to source control" because a new task does not recover another task's uncommitted changes. | [verified] https://help.openai.com/en/articles/20001545-using-codex-cloud |
| OpenAI Codex long run | An experiment ran **about 25 hours, ~13M tokens, uninterrupted** with milestone plan files. Explicitly "an experiment, not a production rollout" and not a documented limit. | [verified] https://developers.openai.com/blog/run-long-horizon-tasks-with-codex |
| Codex CLI sessions | Every session is written to disk as JSONL (messages, tool calls, outputs, token usage) under `~/.codex/sessions`; `codex exec resume <id> "prompt"` continues one non-interactively; `codex exec` runs are hidden from default resume lookup unless `--include-non-interactive`. "The transcript files are the session." | [secondary] https://inventivehq.com/knowledge-base/openai/how-to-resume-sessions ; https://github.com/openai/codex/discussions/1076 |
| Devin | Sleeps after **30 min** idle by default (5 min for Lite and API-created sessions; Enterprise can set 5–120 min). Sleeping uses no usage; any new message wakes it. Awake-but-idle and waiting-for-tests time is not billed. | [verified] https://docs.devin.ai/admin/billing/usage |
| Devin limits | Per-session usage limit puts Devin to sleep after each user message but total consumption does not reset; sessions cannot be continued after 30 days. | [secondary] Devin knowledge base / common-issues search summary |
| Claude Code | Runs until context fills, then auto-compacts; the compaction threshold is configurable (100K–1M tokens); with a 1M window compaction runs at about 967K by default. | [secondary] (threshold from search summary) https://code.claude.com/docs/en/model-config |
| Temporal | Server cannot see a crashed worker by itself; it relies on **Start-To-Close timeout** (max for one attempt) and a **Heartbeat timeout** (worker silent). Default activity retry: exponential backoff, coefficient 2.0, initial 1 s, max interval 100 s, **unlimited attempts** unless capped. | [verified] https://docs.temporal.io/encyclopedia/detecting-activity-failures , https://docs.temporal.io/encyclopedia/retry-policies |
| Vercel Workflow (controller of Cursor pool) | A single workflow run is capped at 10,000 steps / 25,000 events, so long jobs **end and are restarted by a cron/next run**, behaving like one that never stops. | [verified] https://vercel.com/docs/sandbox/ecosystem/cursor |

Pattern: no vendor promises an unbounded single process. They give a **soft, large cap** and make the *job* outlive the *process*.

### 1.2 Restart and resume mechanics

| Mechanism | Who does it | Tag / source |
|---|---|---|
| **Durable state outside the process** | LangGraph checkpoints graph state per super-step per `thread_id`; reuse the thread to resume. Writes of already-finished nodes in a failed step are kept ("pending writes") so they do not re-run. Durability modes: `exit` (save only on exit, cannot survive a crash), `async` (small risk of losing last checkpoint), `sync` (write before next step). Postgres saver for production. | [verified] https://docs.langchain.com/oss/python/langgraph/checkpointers |
| **Heartbeat details as checkpoint** | Temporal heartbeats carry a small progress value; on retry the new worker reads the last one and resumes. Advice: heartbeat timeout 2–3× the heartbeat interval, heartbeat every 10–30 s, keep details small (IDs, offsets, counts), make reprocessing the last checkpoint idempotent, avoid heartbeating in tight loops, test resumption with simulated failures. | [verified] https://docs.temporal.io/design-patterns/long-running-activity |
| **Handoff via files + git** | Anthropic's long-running harness: first session writes `init.sh`, a progress file and a first commit; every later session starts by `pwd`, reading progress file and `git log`, running a smoke test, doing **one** feature, committing and updating the progress file. Found that compaction alone "doesn't always pass perfectly clear instructions to the next agent"; half-implemented work and "declaring victory early" were the main failures. Feature list kept as JSON with a `passes` flag the agent may only flip. | [verified] https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents |
| **Durable project memory** | The Codex 25 h run used four markdown files: spec, plan with per-milestone validation commands and a stop-and-fix rule, a runbook, and a status/decision log. | [verified] OpenAI blog above |
| **Context compaction (summary + recent)** | Claude Code replaces history with a structured summary; re-injects system prompt, CLAUDE.md, memory, the plan, up to 5 recently touched files (files over 5,000 tokens become a path reference), skill bodies (cap 5,000 per skill, 25,000 total); background commands keep running and the model is reminded which ones. Compaction invalidates the prompt cache for the conversation layer, so compact at natural breaks; a summary request after a long idle costs the most. Idle compaction exists. | [verified] https://code.claude.com/docs/en/context-window , https://code.claude.com/docs/en/prompt-caching |
| | OpenHands condenser: when event count passes `max_size` (default **120**) it keeps the first `keep_first` (default **4**) events, summarises the middle with an LLM (often a cheaper one), keeps the tail; result is about `max_size / 2` (60) events. A manual trigger fires on an LLM context-window error. | [verified] https://docs.openhands.dev/sdk/arch/condenser |
| | Codex compaction (PR #3446): stop when context is too large, add a user turn asking for a summary, build a "bridge" of all earlier user messages plus the summary, restart sampling clean. A reported bug: resuming a short session can trigger compaction anyway after a model/context-metadata change. | [verified] https://github.com/openai/codex/pull/3446 , issue #29426 (search result text) |
| **Stuck detection** | OpenHands has a `StuckDetector`; its context-window-error scenario is reported as a stub, so repeated condense cycles can run to `max_iteration_per_run` (default 500) — a warning that compaction needs its own loop breaker. | [secondary] https://github.com/OpenHands/software-agent-sdk/issues/6104 |
| **Interrupts / human pause** | LangGraph `interrupt()` saves state and waits indefinitely; resume with `Command(resume=value)`. | [verified] https://docs.langchain.com/oss/python/langgraph/interrupts |
| **Checkpointer is not a supervisor** | Checkpoints alone do not detect failures, reschedule, or prevent duplicate execution; add those outside. | [secondary] LangGraph/Reddit discussion (search summary) |

### 1.3 What Grok Bot says publicly (all [verified] unless noted)
Sources: https://x.ai/changelog/bot (Aug 12 – Oct 22, 2026 entries), https://cursor.com/docs/grok-bot/work
- Work is **cloud-side and durable**: "Work continues while your laptop is closed"; "closing the app doesn't stop cloud work"; **"Conversations are stored outside the computer, so they survive even a reset."** Files and logins survive normal computer updates; temp dirs and uncommitted app state are "replaceable".
- Hang handling: "A Bot that hangs on an unresponsive command or computer **stops itself with a note, and your next message picks up where it left off**" (Oct 2). "**Stop or a new message ends a Bot that's stuck on an unresponsive step within about 30 seconds**" (Oct 7). "When a Bot asks to wait on a command longer than the time limit, it's told the limit right away" (Oct 14) — a time limit exists for waiting on commands but its value is not published.
- Long jobs: "Your Bot keeps working through long jobs and page-by-page browsing instead of stopping early" (Sep 2). "Commands a Bot runs on your computer keep going through brief connection stalls and long waits." "Bots can wait for a background command to finish, shown as *Waiting on results*." Background jobs keep running after the command returns.
- Restarts: "When the Bot's computer updates, a working Bot reconnects to the new computer and keeps going." "A Bot that asks you to connect an app resumes the task on its own once you finish signing in." "Browser sign-in waits up to 20 minutes … Reopen link resumes the same sign-in." A browser step gives up on a stuck page after 25 seconds; connector calls wait up to two minutes (longer while the connector reports progress), then time out after three minutes in an earlier release.
- Visibility: Bots "acknowledge your message before they start longer work" and "tell you it will take a while" before a multi-minute browser/desktop task. "A notice tells you when routines were paused while you were away." Stalled cloud-agent statuses show "Status unavailable".
- Stop semantics: stopping a Bot also stops background subagents and the cloud agents it started; a launched cloud agent "isn't launched twice when a launch is retried" (idempotent launch).
- Not published: a maximum run time, a step or token cap, how often work is checkpointed.

## 2. What Grok Bot most likely does (all **[inferred]**)

1. The **turn/task state lives in a server-side store**, not on the box (the docs say the box can be reset and conversations survive). A runtime process on or near the box executes steps; if it dies the server still has the transcript.
2. A **liveness check** around each step: an unresponsive command or computer is cut within ~30 s, the Bot posts a short note, and the task is parked until the user's next message (that is the only resume trigger the docs describe for hangs). Automatic resume exists for specific blockers (computer update, app sign-in finished, background command finished, routines).
3. Per-step **soft limits** (browser 25 s, connector 2–3 min, command wait limit) rather than one wall-clock limit; no run-time cap is mentioned for a task as a whole.
4. **Context is condensed server-side** (summaries and facts survive; docs: "summaries from its work … without replaying every prior message"), with the per-Bot memory layer (see docs/MEMORY_NOTES_DESIGN.md) doing the cross-turn carry.
5. Our own session evidence: when a background worker is cut off, the supervising agent receives a **failed-task notice** and restarts the worker with a short "where it stopped" note; the worker's earlier commits survive. That matches "durable state in git + manual/agent-driven resume" more than "transparent auto-resume". The hourly cadence we see is consistent with a **session or credential TTL** [inferred; not proven] — see step 0 for the test.

## 3. Gaps in the original repository snapshot (historical)

What already works [verified in code]:
- Queue and lease: `tasks` has `lease_owner`, `lease_epoch`, `lease_until`, `attempt`, `checkpoint jsonb` (db/001_init.sql). Lease = 20 s (`Routes.cs` lease query); worker heartbeats every 5 s (`worker.py:_heartbeat`); the sweeper in `Program.cs` requeues expired leases with `waiting_reason='lease_expired'`. Each lease bumps `lease_epoch`; status, transcript and tool calls are checked against the epoch, so a stale worker cannot write.
- Transcript: `task_transcript` is written after each model reply and each tool result (`worker.py:_put_transcript`); a restarted worker reloads it and re-runs any tool call without a result (`_unanswered_calls`).
- Tool idempotency key sent with every tool call (`worker.py:_execute_api`); outbound sends have claim/recover logic (`Runtime.cs:RecoverOutbound`, `OutboundRecovery`).
- Stall watchdog: `StallPolicy` (nudge at `STALL_SECONDS`, default 300; block at 2×) uses `last_progress_at`, which every tool call refreshes (`Runtime.cs:791`, `CodingTools.cs`); blocked tasks post "I'm stuck on …" and notify.
- Plan: `plan_set`/`plan_update` in `task_plan_items`, mirrored to `/workspace/.progress/task-<id>.md` (`CodingTools.cs:WritePlan`) — already a handoff file.
- Computer recovery: `waiting_resource/computer_recovering` tasks are requeued when the computer is restored (`Platform.cs:ResumeRecoveringTasks`); missing key waiters resume (`Reliability.cs`).
- Budgets exist: defaults 200 steps / 3600 s, clamped 4–1000 steps and 30–21,600 s (`CodingWork.cs:RunBudget`), set per task or per bot.

Gaps (each one maps to a build step in section 6):

| # | Gap | Evidence | Effect |
|---|---|---|---|
| G1 | **Budgets reset on every resume.** `RunGuard` and the model-round counter are created fresh in each `execute()`; `started`, `steps`, `rounds` are in memory only. | `worker.py` `execute`: `rounds = 0`, `RunGuard(...)`; `run_guard.py` `time.monotonic()` | A task that gets re-leased 10 times can run 10× its budget; and a real cap is never enforceable across attempts. |
| G2 | **Hitting a budget is terminal.** `step_budget`, `time_budget`, `repeat_loop` and the 12-round cap call `_fail`. | `worker.py` (`MAX_MODEL_ROUNDS = 12`, `_fail(task, blocked)`); `Reliability.cs:TaskErrors` | Useful long work ends as "failed" instead of "paused, continue?". Compare Devin/Cursor, where hitting a limit pauses and a message continues. |
| G3 | **No context management.** The whole message list is sent each turn; no token count, no summarising, no truncation of old tool output. | `worker.py` (no token logic; `grep compact|summar|truncate` finds none); `guard.py:present_tool` only marks untrusted text | Long tasks will hit the model's window or get slow and expensive; the first symptom would be a provider error that `_fail`s the task. |
| G4 | **Transcript is rewritten, not appended.** Each step does `DELETE FROM task_transcript` then re-inserts every row. | `Routes.cs` PUT `/internal/tasks/{id}/transcript` (lines ~1119–1132) | O(n²) rows written over a long task; every step re-sends and re-inserts the whole history, so each step gets slower as the task grows. (It runs in a transaction, so it is crash-safe.) |
| G5 | **No resume brief.** A resumed attempt just replays the saved messages. Nothing tells the model "you were interrupted; a tool may have half-run; check git status and the plan first". | `worker.py:execute` | Model can repeat or skip work; the Anthropic harness found this is the main failure after context loss. |
| G6 | **`tasks.checkpoint` is almost unused** (only `{"phase":"holding"}` in the recovery test). No record of last commit, step count, plan position. | `worker.py:_hold`; grep | Nothing durable for the watchdog, the UI or the brief to read. |
| G7 | **No "resumed" visibility.** `lease_expired` requeue writes no event and no chat line; only `resource_resumed` (OpenRouter key) emits an event. | `Program.cs` lease sweeper; `Reliability.cs` `resource_resumed` | The user sees a task silently restart, or just sit "queued" for a moment. |
| G8 | **No cap on automatic attempts and no no-progress breaker.** `attempt` increments forever; backoff is none (requeue is immediate). | `Routes.cs:1049` | A task that crashes the worker at the same step would loop at full speed (Temporal's default of unlimited retries has the same risk, which is why it has a backoff). |
| G9 | **Side-effect re-run risk for non-outbound tools.** An unanswered `shell`/`write_file` call is re-executed on resume; the idempotency key is sent, but I only confirmed it is honoured for outbound actions. | `worker.py:_unanswered_calls`; `Runtime.cs:799-954` | A half-run command (e.g. a migration) could run twice. [Not verified whether `shell` dedupes on the key.] |
| G10 | **Stall watchdog is blind to context rot.** It nudges once with a message; it never tries "compact and restart the attempt". | `Program.cs:217-229`; `StallPolicy` | Many real stalls are a model stuck in a long, confused context. |
| G11 | **No git snapshot for coding tasks.** Uncommitted edits live only in the working tree; Codex docs warn the same about cloud tasks. | docs/CODING_WORK.md | A computer reset between commits loses work. |

## 4. Design

### 4.1 Principles
1. **The task outlives the worker.** A worker may die at any step; correctness never depends on one process finishing.
2. **State in the database and git, not memory.** The model's context is a cache that can be rebuilt from the ledger.
3. **Limits pause, they do not destroy.** A budget or an exhausted resume allowance moves the task to `waiting_human` with a Continue button; only unrecoverable errors fail.
4. **Never silently.** Every resume, compaction and pause produces an event and a short inline notice.
5. **Safe by default.** Auto-resume never crosses an approval, never repeats an unknown-outcome side effect without checking, and is always bounded.

### 4.2 Checkpoint ledger (uses the existing `tasks.checkpoint` column)
Written by the API (not the worker's memory) on: each tool result (cheap counters only), each `plan_update`, each `git_commit`, each compaction, and each lease.

```json
{
  "v": 1,
  "stepsUsed": 412,            // cumulative across attempts
  "secondsUsed": 2810,         // sum of active wall time per attempt (lease start to last heartbeat)
  "modelRounds": 57,
  "attempts": [{"n":3,"startedAt":"…","endedAt":"…","endReason":"lease_expired","stepsAtEnd":412,"progress":true}],
  "lastCommit": {"sha":"9ab64e2","branch":"task/ab12cd34","at":"…"},
  "snapshotRef": "refs/teammates/checkpoints/ab12cd34",
  "planPosition": {"done":4,"total":9,"current":"Add retry tests"},
  "compactions": 2,
  "lastToolCallId": "call_…",
  "unresolvedCalls": ["call_…"],   // calls sent but no result recorded
  "lastProgressAt": "…"
}
```
Rules (from Temporal's advice): keep it small (counts, ids, shas; **no tool output, no file contents, no secrets**; hard cap 8 KB [guess]); updates are idempotent; the transcript remains the source for conversation content.

Also add the table `task_run_events` (exists) event types: `resumed`, `compacted`, `budget_reached`, `resume_exhausted`, `no_progress`.

### 4.3 Cumulative budgets (G1, G2)
- `RunGuard` is seeded from the ledger: `steps = stepsUsed`, `elapsed = secondsUsed`, `rounds = modelRounds`. Keep a second, smaller **per-attempt** cap (e.g. 400 steps or 30 min per attempt [guess]) so one attempt cannot run forever without a checkpoint.
- The 12-round cap becomes configurable per task kind and cumulative; for coding tasks it is raised or removed because steps and time already bound them [guess; needs a product decision].
- On budget hit: status `waiting_human`, reason `budget_reached`, an inline card "I used my work budget (412/400 steps, 47 min). Continue with +200 steps · Raise budget · Stop", and an event. Continue adds to `budget_steps/seconds` (bounded by the existing 1,000 / 21,600 clamps unless the owner raises them) and requeues with a new epoch.
- `repeat_loop` / `invalid_repeat` stay terminal-with-explanation but also offer "Retry with a hint".

### 4.4 Auto-resume policy (G7, G8)
State machine additions (no new statuses needed; reuse `queued` + `waiting_human` + `waiting_resource`):

| Trigger | Action | Notice |
|---|---|---|
| Lease expired (worker died, restart, network) | Requeue after backoff `min(2^(n-1)·2 s, 60 s)` [guess]; `n` = consecutive resumes without progress | "Resumed after an interruption (attempt 3). Continuing from step 412 of the plan: *Add retry tests*." |
| Computer restored | Existing requeue + event | "My computer restarted; I'm continuing." |
| Key/connector added | Existing requeue + event | existing `resource_resumed` |
| Budget Continue / user "continue" | Requeue | "Continuing with a bigger budget." |
| Waiting for approval / login / human control | **Never auto-resumed**; only the user's action resumes | — |

Bounds:
- `max_auto_resumes` per task: **5** within any rolling hour [guess], then `waiting_human` reason `resume_exhausted` with "I was interrupted several times; continue?".
- **No-progress breaker:** an attempt makes *progress* if it recorded at least one new tool result that changed state (write, commit, plan update, new file) or advanced the plan. Two consecutive attempts without progress → `waiting_human` reason `no_progress`; a note names the last tool call so the user (or a human-readable log) can see where it dies. This protects against a poison step looping (G8).
- Backoff and the cap are logged in events so they can be tuned from data.

### 4.5 Resume brief (G5, G9)
On any attempt where `attempt > 1`, the worker appends one synthetic message **before** continuing (stored in the transcript, hidden from the chat UI):

```
You were interrupted and restarted (attempt N, reason R, at step S of the budget).
Goal: <task instruction, first 1,000 chars>
Plan (from the plan items): [x] 1 … [x] 2 … [ ] 3 <current> …
Repo state: branch <b>, last commit <sha> "<subject>", <k> uncommitted files: <names only>.
Calls with unknown outcome: <tool + args summary>. They may have partly run. Check the result (git status, file contents, command output) before running them again. Do NOT repeat sends, payments or deletes without verifying.
Historical handoff note from the original design pass. Subsequent implementation and validation are recorded in [`LONG_RUN_RESUME_IMPLEMENTATION.md`](LONG_RUN_RESUME_IMPLEMENTATION.md) and [`WT-PROGRESS-resume.md`](WT-PROGRESS-resume.md); use the current checkout and tests to determine any remaining work.
```
The API builds the plan, repo state and unknown calls from the ledger and one `git_status` call, so it works even if the model's context was compacted. This is the Anthropic "get your bearings" sequence, made automatic.
For non-idempotent tools (`shell`, `write_file`, anything with side effects outside the workspace), an unanswered call is **not** re-executed automatically: it is listed as unknown-outcome in the brief and the model decides after checking. Read-only tools and outbound actions with a stored idempotency claim re-run as today.

### 4.6 Context compaction (G3, G4, G10)
Trigger (either): estimated prompt tokens ≥ **70% of the model's context window** [guess; Claude Code's default is near the full window — 967K of 1M [secondary] — but we send raw tool output, so compacting earlier is cheaper; make it a setting], or message count > **120** (OpenHands default [verified]).
Token estimate: use `prompt_tokens` from the last model call (already stored in `model_calls`) plus a chars/4 estimate for new messages [guess]; the model's window comes from the OpenRouter model metadata, with a conservative default (32K [guess]) if unknown.

Two stages, cheapest first:
1. **Observation masking.** Replace old tool outputs (older than the last 10 results [guess]) with `"[output elided: <tool>, <n> bytes, call_id]"`, keeping the call and its arguments. No LLM call. Often enough alone.
2. **LLM summary of the middle.** Keep: system prompt, first user message, plan block, the last 20 messages [guess] (never splitting a tool call from its result), and a structured summary of everything between. Summary prompt (cheaper model, no tools, JSON out): goal; decisions and why; files touched; commits (sha + subject); commands that mattered and their outcomes; errors and fixes; open issues; the exact next step. Cap the summary at ~1,500 tokens [guess].
Invariants (tests in section 7): never drop an **unanswered** tool call; never split call/result pairs; keep the latest plan state; compaction is idempotent; the pre-compaction messages are **archived** (new table `task_transcript_archive`, same task, `compaction_id`) for audit and for "show full history".
Cache note [verified, Claude docs]: compaction invalidates the conversation cache, so prefer compacting at a **plan-item boundary** (right after a commit) when the threshold is soft-crossed (≥60%), and compact immediately at ≥85% [guess].
Loop breaker (OpenHands lesson [secondary]): if two compactions in a row do not bring the estimate below the trigger, or a provider context error follows a compaction, move to `waiting_human` reason `context_exhausted` rather than looping.
Transcript storage (G4): change PUT to **append-only** with `seq`; keep `DELETE`+reinsert only inside a compaction transaction (swap in the summary, move the old rows to the archive).
Stall integration (G10): on the second stall stage, before `blocked_reason='stalled'`, run one forced compaction + a fresh attempt ("clean-context retry"); block only if that also stalls.

### 4.7 Git snapshot for coding tasks (G11)
After each successful tool batch that changed files, at most once per 5 minutes [guess], run `git stash create` (writes a commit object **without touching the working tree, index or branch**) and store its sha in `refs/teammates/checkpoints/<task8>` with `git update-ref`. The ledger records `snapshotRef`. The resume brief lists it; after a computer reset the brief can say "snapshot <sha> exists; run `git stash apply <sha>` if the tree is clean". Real commits stay the normal checkpoint (`git_commit` through hooks). Never `--no-verify`, never push automatically.

### 4.8 User-visible notices
Event rows (existing `task_run_events` + SSE `Publish`) → inline chat line, same style as the "Saved to notes" notice in the memory design:
- `resumed`: "Resumed after an interruption · attempt 3 · continuing: Add retry tests" with a small "Details" expander (reason, how long it was down, steps used). Several resumes within 10 minutes collapse into one line "Resumed 3 times in 8 min".
- `compacted`: "Condensed earlier work to keep going (kept the plan and last 20 steps)" with "View full history".
- `budget_reached`, `no_progress`, `resume_exhausted`, `context_exhausted`: a card with the action buttons (Continue, Raise budget, Stop).
- Tasks pane and coding list: a "↻ 3" badge on the task; the Computer card shows "Waiting to resume" during backoff.
- Notifications: push only for states that need the user (the four cards above), never for an ordinary resume.
- Web touch points: `apps/web/lib/events.ts`, `components/bot-thread.tsx`, `components/workspace.tsx`, `tool-status.ts`.
- Copy rule: say what happened and what is next; never show raw command text or paths in the notice.

### 4.9 Heartbeat and lease (small changes)
- Keep lease 20 s / heartbeat 5 s (a 4:1 ratio; Temporal recommends heartbeat timeout of 2–3× the interval [verified], ours is stricter; it is fine given a local DB).
- Heartbeat body carries `{stepsUsed, lastToolCallId, lastProgressAt}` so the API updates the ledger without a second call (Temporal "heartbeat details" pattern).
- Add `max_lease_age`: if one lease epoch exceeds the per-attempt cap, the worker voluntarily ends the attempt after a checkpoint ("rolling restart"), which also refreshes any short-lived credentials — the same trick the Vercel controller uses with 10,000-step workflow runs [verified]. This turns a hard TTL cut into a planned handoff.

### 4.10 Dev-workflow stopgap for our own build workers (not product code)
The hourly cut-offs hit the coding agents building this repo, not AI Teammates' worker. Until the product features exist:
- Each worker keeps `/workspace/ai-teammates-live/PROGRESS.md` (plan checklist, last commit, next step) and commits after each unit of work.
- A tiny supervisor script polls the worker's state; on exit it relaunches with the standard resume prompt (read PROGRESS.md and `git log -5`, check `git status`, continue with the first unchecked item) and records `{wall_seconds, tool_calls, exit_reason}` to a log. After 5–10 interruptions the log shows whether the cut is a fixed wall-clock (credential TTL) or a call/context count.

## 5. Security notes

1. **Fencing stays authoritative.** Every ledger, transcript, archive, compaction and event write checks `lease_epoch` like status/transcript do today. Test with a stale worker (section 7).
2. **Auto-resume never bypasses approvals.** States `waiting_approval`, `waiting_human` (login, takeover, tests_required, captcha) are excluded from every automatic path in 4.4; Auto-review rules and the owner's "ask first" settings apply on each resumed action as normal.
3. **No duplicate side effects.** Unknown-outcome calls with external effects are never replayed blindly (4.5); outbound actions keep the claim/evidence recovery in `OutboundRecovery`. Verify (and test) whether `/internal/tools/execute` dedupes `shell` and file writes on `idempotencyKey`; if not, add it.
4. **Secrets.** Ledger, resume brief, summaries and notices pass through the existing `scrub`/`Dlp.Redact` and `InjectionFilter.ScrubJson` before storage and before they enter a prompt. The summariser is told never to copy tokens, passwords, card numbers or one-time codes; a post-filter rejects a summary that matches secret patterns and falls back to observation masking only.
5. **Prompt injection through summaries.** A summary of web text is derived from untrusted content. Wrap quoted web/tool excerpts with `wrap_untrusted` (as `guard.py` does), instruct the summariser to describe instructions found in data rather than repeat them, and mark the summary message `untrusted: true` so later turns keep treating embedded instructions as data.
6. **Bounded cost and loops.** Cumulative budgets (4.3), `max_auto_resumes`, the no-progress breaker, backoff and the compaction loop breaker are all hard bounds; per-owner spend limits still apply to the extra model calls from summarising. Compaction calls are logged in `model_calls` with `role='compactor'`.
7. **Tenant isolation.** Ledger, archive and events are keyed by `task_id` and read only through owner-checked routes (as `Routes.cs` does for tasks). Git snapshot refs live in the owner's own computer workspace; refs and shas are not exposed to other users or bots.
8. **Notice content.** Notices and events carry reason codes, counts and plan titles only — never command lines, file contents, URLs with tokens, or tool output.
9. **Audit.** `platform.Audit` entries for `task.resumed`, `task.compacted`, `task.budget_continue` (with who clicked Continue), so unexpected activity is traceable.
10. **Archive retention.** `task_transcript_archive` follows the task's retention and deletion (cascade on task delete), and is excluded from the model prompt.

## 6. Build order and estimates

Estimates are engineer-days **[guess]**, one engineer, including tests; calendar time assumes parallel Codex workers.

| # | Step | Depends on | Est. | Done when |
|---|---|---|---|---|
| 0 | Dev-workflow supervisor + PROGRESS.md convention; log wall-clock and tool calls at each interruption (4.10) | — | 0.5 d | Two interruptions logged with timings; resume works unattended. |
| 1 | Ledger in `tasks.checkpoint` + heartbeat details (4.2, 4.9); `resumed` event on every lease-after-expiry | — | 1.0 d | Killing the worker produces one `resumed` event with attempt and reason. |
| 2 | Cumulative budgets: seed `RunGuard` and rounds from the ledger; `budget_reached` waiting state with Continue/Raise (4.3) | 1 | 1.5 d | A task re-leased 3 times cannot exceed its budget; budget hit ends in `waiting_human`, not `failed`. |
| 3 | Append-only transcript PUT (G4) | — | 0.5 d | Transcript write cost no longer grows with task length; existing tests pass. |
| 4 | Resume brief + unknown-outcome handling for non-idempotent tools; confirm/add idempotency on `shell`/`write_file` (4.5, security 3) | 1 | 1.5 d | After killing the worker mid-`shell`, the brief lists it and the model verifies before repeating. |
| 5 | Resume policy: backoff, `max_auto_resumes`, no-progress breaker, excluded states (4.4) | 1 | 1.0 d | Poison-step task stops after 2 no-progress attempts with a card. |
| 6 | User-visible notices and cards (4.8), SSE events, web components, audit | 1, 2, 5 | 1.5 d | Playwright sees the resumed line, the collapse, and the Continue card. |
| 7 | Compaction stage 1 (token estimate + observation masking) and stage 2 (LLM summary, archive, invariants, loop breaker) (4.6) | 3 | 3.0 d | A 300-step mock task finishes within a small configured window; invariants hold. |
| 8 | Watchdog escalation: forced compaction + clean-context retry before `stalled` (4.6) | 7 | 0.5 d | A scripted stall recovers via clean-context retry. |
| 9 | Git snapshot refs for coding tasks (4.7) | 1 | 0.75 d | After deleting the working tree changes, the brief shows a restorable snapshot. |
| 10 | Chaos and acceptance hardening (section 7) | all | 1.5 d | Chaos run green 20 times in a row. |

Total ≈ **13.25 d** if every row is done; core path (0, 1, 2, 3, 4, 5, 6, 7) ≈ **10.5 d**. So **~10–13 engineer-days [guess]**, **~7–9 calendar days** with parallel agents [guess]. Quick win: steps 0, 1, 2, 6 alone (≈ 4.5 d) already give cumulative limits, visible resumes and a Continue button.

## 7. Test plan

Use the existing mock-openrouter planner (`services/mock-openrouter/planner.py`) to script long deterministic tasks; run in the integration stack (`tests/integration/test_reliability_v04.py` is the natural home; add `test_long_run_resume.py`).

**Unit (C# and Python)**
- `RunGuard` seeded from a ledger: continues counting; per-attempt and cumulative caps both fire; resets only when the ledger says so.
- `StallPolicy` extension: nudge → clean-context retry → block, with fake clock.
- Resume classifier: each reason maps to the correct action; excluded states are never requeued.
- Backoff function and rolling-hour `max_auto_resumes` window.
- Compaction invariants over randomised transcripts: no orphan tool call/result; unanswered calls preserved; first user message and system prompt preserved; plan block preserved; idempotent on repeat; token estimate monotonic after masking.
- Ledger size cap and scrub: a secret placed in tool output never appears in ledger, brief, summary or event JSON.

**Integration**
1. Kill the worker (`kill -9`) at step 40 of a 120-step mock plan → lease expires within ~25 s → exactly one `resumed` event → task completes; `stepsUsed` equals 120 ± the one replayed read-only step; no duplicate write.
2. Stale-worker fencing: pause the first worker (SIGSTOP), let the lease expire and a second worker resume, then SIGCONT the first; its transcript, ledger, tool and fail calls all return 409/lease-gone and change nothing.
3. Cumulative budget: budget 50 steps, kill the worker every 20 steps; the task ends in `waiting_human/budget_reached` at step 50, not at 20-per-attempt; Continue adds the extra steps and finishes.
4. Poison step: tool that always kills the worker → after 2 no-progress attempts: `no_progress` card, no further requeue, backoff observed in event timestamps.
5. `max_auto_resumes`: 6 kills within an hour → `resume_exhausted` after the 5th.
6. Approvals: a task in `waiting_approval` is never requeued by the sweeper, `ResumeRecoveringTasks`, or the new policy.
7. Unknown-outcome tool: kill during a `shell` call that appends to a file; after resume the file has the line once (or the model is told and verifies).
8. Compaction: mock planner emits 200 KB tool outputs; configured window 32K; the task completes; `compacted` events present; archive rows match the removed range; `model_calls` has `role='compactor'`; a provider context error after compaction yields `context_exhausted`, not a loop.
9. Transcript append-only: row ids for old messages are stable across 100 steps; write time per step stays flat.
10. Git snapshot: edit files, delete the working-tree changes, `snapshotRef` restores them with `git stash apply`; branch and index untouched while the snapshot is taken.

**Chaos** (nightly): random worker kills every 15–90 s, random 2–10 s network drops between worker and API, one computer restart, during a 300-step scripted task and a coding task with commits. Pass: task completes; no duplicate side effects; ledger consistent with transcript; notices collapsed (≤ 1 line per 10 min burst); total extra model cost < 10% over the uninterrupted baseline [guess target].

**UI (Playwright)**: resumed line appears and collapses; Details expander shows reason and counts and no command text; Continue/Raise budget cards work; badge count; no push notification for an ordinary resume.

**Security**: injection text in a fetched page is inside `wrap_untrusted` in the summary and the model does not obey it (mock model asserts); secret patterns in summaries rejected; notices contain no paths or commands; audit entries exist for resume, compaction and Continue; cross-owner request for another user's ledger/archive/events returns 404.

**Acceptance for the original problem:** run the mock task with a 60-second "forced hourly cut" setting (worker exits at 60 s) for 20 minutes; the task finishes without a human, shows the correct number of resume notices, and the final result equals the uninterrupted run.

## 8. Open decisions for Saad
1. Should hitting the step/time budget **pause with a Continue button** (recommended) or stay a failure?
2. Raise or remove the 12-model-round cap for coding tasks? (Today it ends a task after 12 model replies per attempt.)
3. Cheaper model for compaction summaries (cost and speed) or the task's own model (consistency)?
4. Auto-resume ceiling: 5 per hour is a guess; do you want a different default or a per-bot setting?
5. Should a resume push-notify, or only the "needs you" cards? (Recommended: only the cards.)
6. Do you want the git snapshot refs on by default for coding tasks, or opt-in?

## 9. Sources
- Cursor: https://cursor.com/docs/release-notes/cloud-agents · https://cursor.com/docs/cloud-agent/settings · https://vercel.com/docs/sandbox/ecosystem/cursor · https://cursor.com/docs/cli/reference/slash-commands (secondary)
- OpenAI: https://help.openai.com/en/articles/20001545-using-codex-cloud · https://developers.openai.com/blog/run-long-horizon-tasks-with-codex · https://github.com/openai/codex/pull/3446 · https://github.com/openai/codex/issues/29426 · https://github.com/openai/codex/discussions/1076 · https://inventivehq.com/knowledge-base/openai/how-to-resume-sessions (secondary)
- Anthropic: https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents · https://code.claude.com/docs/en/context-window · https://code.claude.com/docs/en/model-config · https://code.claude.com/docs/en/prompt-caching
- Devin: https://docs.devin.ai/admin/billing/usage
- OpenHands: https://docs.openhands.dev/sdk/arch/condenser · https://github.com/OpenHands/software-agent-sdk/issues/6104 (secondary)
- LangGraph: https://docs.langchain.com/oss/python/langgraph/checkpointers · https://docs.langchain.com/oss/python/langgraph/persistence · https://docs.langchain.com/oss/python/langgraph/interrupts
- Temporal: https://docs.temporal.io/encyclopedia/detecting-activity-failures · https://docs.temporal.io/encyclopedia/retry-policies · https://docs.temporal.io/design-patterns/long-running-activity
- Grok Bot: https://x.ai/changelog/bot · https://cursor.com/docs/grok-bot/work · https://docs.x.ai/grok-bot/computer-and-apps (search summary only)
- This repo: `services/agent/worker.py`, `services/agent/run_guard.py`, `apps/api/CodingWork.cs`, `apps/api/Program.cs` (sweeper, stall), `apps/api/Routes.cs` (lease, transcript), `apps/api/Reliability.cs`, `apps/api/Platform.cs`, `apps/api/CodingTools.cs`, `db/001_init.sql`, `db/012_reliability.sql`, `db/019_coding_work.sql`.
