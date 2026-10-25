# Routines: how Grok Bot does it, and a design for AI Teammates

Status: historical design proposal, not an implementation status report. Routines are implemented in the integrated tree; use `apps/api/RoutineService.cs`, `apps/api/RoutineSchedule.cs`, `apps/api/RoutineRuns.cs`, and current web source for shipped behavior. The target behavior and estimates below are not a completion checklist. Written 2026-10-23.

## 1. How Grok Bot routines work

Sources: the Cursor-managed `routines` skill and `UpdateRoutine` tool contract that this assistant runs on (I could not open the tool description through `GetDynamicTools`, so the tool facts come from the skill text), plus the public docs listed in section 2.

**A routine is a saved prompt plus a trigger. The user never fills a form: they ask the Bot in chat, the Bot calls one tool, the user confirms on a card, and the panel only lists, toggles and deletes.**

- Public doc: "Ask the Bot in chat. Say what it should do and when." Editing starts a chat message that begins "Edit your routine:". The panel row has a switch that pauses or resumes (https://cursor.com/help/grok-bot/routines).
- One tool, `UpdateRoutine`, with actions create, get, update, pause, resume, delete. To change a routine the Bot first calls `get` to read the saved prompt, trigger and timing, then edits that text instead of rewriting it from memory.
- Creating or changing a routine may show a confirmation card with the schedule and instruction. The user's answer comes back as the tool result. The Bot must not ask permission first and must not retry a denied write with reworded text. A change that only saves usage waits for the user's yes.
- Schedule: a 5-field cron string in the user's local timezone. `CRON_TZ=<IANA zone> ` prefix pins another zone. Shorthands `@hourly @daily @weekly @monthly` and `@every 5m|2h|1d` work. Minimum spacing is 5 minutes.
- Flexible vs exact timing is done by the Bot when it writes the minute field. "8am" with no minute lands within 15 minutes of 8:00, based on the minute of the message timestamp (asked at 1:47, "8am" becomes `47 7 * * *`) and the Bot tells the user the exact saved time. Only an explicit minute ("9:30", "8 sharp", "exactly 9") is saved as named. Never `*/30` or `0,30` unless asked. This spreads load and avoids top-of-hour spikes.
- Default window is weekdays, roughly 8am to 7pm local. Off-hours or weekends need a stated reason (user said so, time-critical, personal-life reminder such as medication).
- Prompt style: write an intent, not a frozen tool recipe. End with a plain line saying who receives the result and what happens when nothing is new. Each run follows that line literally.
- Triggers instead of schedule: slack (channel, mention/keyword/message/reaction), github, origin, microsoftTeams, linear, sentry, pagerduty, email (inbox, optional senders, auth check on by default), webhook (URL plus bearer key shown in the panel), cron (a schedule written as a listener), and group (several listeners, any one fires the same prompt). Event triggers are preferred over polling. Never pass both `trigger` and `schedule`.
- Run: the scheduler or listener wakes the Bot with the saved prompt as a hidden turn. Event wakes include the event in a tagged block such as `<email_received>` (headers only; the Bot reads the body itself). Mail-woken runs are untrusted and cannot freely edit their own routine.
- Quiet: the saved prompt says what to do when nothing changed (usually "say nothing"). A run that has nothing to report sends nothing.
- Short-lived watches expire themselves: PR watches delete after merge or close, scheduled watches carry a deadline in the prompt and delete after reporting.
- Failure: if a connector keeps failing auth, the Bot pauses the routine and tells the user what to reconnect.
- Public limits and behaviours: schedule must be at least 5 minutes apart; a Bot can own up to 50 routines; run history keeps the last 20; saving never runs it (the first run is the next match); Test performs real work; the timezone comes from Settings > Bot with auto-detect (https://metagrok.io/how-to/set-schedule-on-a-grok-bot-routine, a third-party guide that cites the official docs).

## 2. Design patterns from similar products

| Pattern | Source |
|---|---|
| Natural language creates the task; edit by following up in the same conversation | ChatGPT, https://help.openai.com/en/articles/10291617-tasks-in-chatgpt |
| One-off and recurring; flexible windows (morning, afternoon, night) on free, exact times on paid; limits 3/5/10/15 active tasks by plan; event-triggered tasks capped at 30 per hour and 720 per day; inactive tasks may pause automatically | same page |
| Schedules once, daily, weekdays, weekly, monthly, yearly in the user's timezone; email triggers; Run now; delivery by email, app notification, both or none | xAI Grok Automations, https://x.ai/news/grok-automations |
| Pause, edit, archive, delete with history kept | Grok Tasks coverage, https://www.ainews.com/p/xai-launches-grok-tasks-to-automate-real-time-ai-monitoring-and-analysis (third party) |
| Chat-created tasks via `CronCreate/CronList/CronDelete`; local timezone; jitter (recurring runs up to half the gap late, max 30 minutes, to spread load); one-shot reminders delete themselves; recurring tasks expire after 7 days; no catch-up, a missed fire runs once | Claude Code, https://code.claude.com/docs/en/scheduled-tasks |
| Run history includes skipped runs with the reason (asleep, previous run still going); on wake exactly one catch-up run for the most recent missed time within 7 days, others discarded; Status Active/Paused; a task can reschedule itself with `update_scheduled_task` | Claude Code Desktop, https://code.claude.com/docs/en/desktop-scheduled-tasks |
| Cloud tasks have schedule, API and GitHub triggers, may combine triggers, minimum interval 1 hour | https://code.claude.com/docs/en/routines |

Takeaways for us: create by chat; cron is the stored form; timezone is explicit; jitter by default; one-shot self-deleting reminders; one catch-up run at most; history with skip reasons; per-user caps; auto-pause of dead routines.

## 3. What AI Teammates has today (read from `src`)

Working:
- `routines` and `routine_runs` tables (db/001_init.sql), `watch_kind/ref/fingerprint` (db/009), `created_by_bot_id`, `origin_depth` (db/015).
- Scheduler inside `apps/api/Program.cs` maintenance loop (every 2 s): selects due routines, optional change-only skip for `http`/`memory` watches (SHA-256 fingerprint, no model call when unchanged), skips if the previous task is still running, inserts a `work` task from the saved instruction, then recomputes `next_run_at` from now (no backlog).
- API: GET/POST `/api/bots/{id}/routines`, PATCH `/api/routines/{id}` (enabled, nextRunAt) in `Routes.cs`; `RoutineToggle.NextAfterEnable`.
- Bot tools `list_routines` and `create_routine` (`ToolSchema.cs`, `BotMessaging.cs`): classified `bot_manage`, which defaults to Ask, so an approval card appears. Limits: 15 minutes minimum, 10 routines per bot, 3 management actions per task, DLP check, idempotency key, audit row, depth limit.
- UI: `routines-pane.tsx` (create form + list) and a new `routines-section.tsx` with `cronToWords` and a Switch (in progress, uncommitted).

Gaps:
1. **Timezone is ignored.** Every `Cron.Next` call passes `TimeZoneInfo.Utc`. `routines.timezone` exists but is never written or read. The user's timezone lives only in browser localStorage (`teammates-timezone`). "8am" therefore fires at 8:00 UTC.
2. The model must hand-write cron; the tool description gives no timestamp, timezone, jitter or default-window rules. The mock planner always writes `0 * * * *`.
3. Only create and list exist. No get, update, pause, resume or delete tool, so a user asking "change it to 9" or "stop the reminder" has no path except the panel.
4. No one-off reminders (every routine recurs) and no expiry or deadline.
5. No jitter or flexible window; minute fields are used exactly as written.
6. `routine_runs` is written as `queued` or `skipped` and never updated when the task finishes. No endpoint or UI shows history. An overlap skip writes no row.
7. No quiet rule: a routine's final answer is handled like any task answer (`task.complete` notification). I did not find any "nothing new" handling in `services/agent/worker.py`.
8. Triggers: only cron plus `http`/`memory` change watches. No email, webhook or bot-message triggers.
9. Scheduler is not safe for two API instances: due rows are read without `FOR UPDATE SKIP LOCKED`, so both could fire. `Cron.Next` also scans minute by minute (up to 527,040 iterations) per call, and invalid cron saved through the HTTP POST throws instead of returning 400. The HTTP POST has no 15-minute floor and no routine cap (only the bot tool does).
10. No failure handling: repeated failed runs never pause the routine; no missed-run policy beyond "skip to next".
11. Web form is a manual path the user wants removed from the main flow.

## 4. Design

### 4.1 Principle
Creation, edits and deletion happen in chat through tools. The right panel is a read-only list plus an on/off toggle (and delete with confirm). The panel's old create form is removed or hidden behind "Ask in chat".

### 4.2 Data model (migration 0xx_routines_v2.sql)
Add to `routines`: `timezone` (use the existing column; now filled), `kind text` ('recurring'|'once'), `run_at timestamptz` (for once), `jitter_seconds int`, `expires_at timestamptz`, `trigger jsonb` (null for schedule), `failure_streak int`, `paused_reason text`, `quiet_rule text`. Add to `routine_runs`: `scheduled_for`, `finished_at` (exists), `error`, `skip_reason`, `summary`, `notified bool`. Keep the last 20 runs per routine (prune on insert). Add per-user `user_settings.timezone` (IANA, default from browser on first load, editable in Settings).

### 4.3 Tools for bots (all classified `bot_manage` except list/get = read)
- `list_routines(bot?)`: id, name, schedule in words, nextRunAt, enabled, kind.
- `get_routine(id)`: full saved instruction, cron, timezone, trigger, expiry, last runs.
- `create_routine(bot?, name, instruction, schedule | runAt | trigger, timezone?, expiresAt?)`: approval card shows name, schedule in words with the zone, next run, instruction. Returns exact saved time so the bot can tell the user.
- `update_routine(id, ...fields)`: approval card shows a before/after diff. Must be preceded by `get_routine` in the same task (server checks) so edits are made on the saved text.
- `pause_routine(id)`, `resume_routine(id)`: pause needs no card (reduces risk); resume asks.
- `delete_routine(id)`: card; irreversible.
Server-side validation shared with the HTTP path (one `RoutineService`): parse cron, 5-minute floor, per-bot cap (suggest 50 later, 10 now), DLP, injection-stripped event text, idempotency key.

### 4.4 Natural language to cron and timezone
The model produces the structured schedule; the server validates and normalises. The tool description and system prompt carry the rules copied in spirit from Grok Bot: current local time and zone are injected into every turn; default to weekdays 8am to 7pm unless the user says otherwise; pick the minute from the timestamp when the hour has no minute; explicit minutes kept; never `*/30`. A server `ScheduleNormalizer` rewrites `*/N` minute fields into an explicit phased minute list and rejects any schedule under 5 minutes apart. All `Cron.Next` calls use the routine's zone (`TimeZoneInfo.FindSystemTimeZoneById`), with DST rules tested (skipped hour, repeated hour). Responses always include `humanSchedule` from the existing `cronToWords` port in C# (or return it from the model-confirmed summary) so the card and panel read the same.

### 4.5 Flexible timing and jitter
`jitter_seconds` default: min(half the gap, 15 min) for hour-level or longer schedules, 0 for gaps of 5 minutes or less. `next_run_at` stores the jittered time; `scheduled_for` stores the nominal time. Deterministic per routine (hash of id) so a daily routine fires at the same offset every day, matching Claude Desktop's behaviour. "Exact" requests (`exact: true`) set jitter to 0.

### 4.6 One-off reminders
`kind='once'`, `run_at` in UTC from a local time the user gave. Fires once, then sets `enabled=false` and `finished` (or deletes after 7 days). Reminders delivered as a chat message in the bot's conversation plus the existing push/email notification. "In 45 minutes" uses a timestamp, not cron.

### 4.7 Event triggers (later)
Same table, `trigger` JSON: `email` (the bot's inbox, optional sender list, SPF/DKIM pass required, headers only in the wake), `webhook` (per-routine URL and bearer key shown only in the panel, 200 means accepted not finished), `bot_message` (a message from a named bot), `group` (any of several). Event text is untrusted: wrapped, DLP-stripped, and the run may not edit its own routine without a card. Rate cap per user (for example 30 per hour) with a "dropped N events" run row.

### 4.8 Execution model
Scheduler tick selects due rows with `FOR UPDATE SKIP LOCKED` and in one transaction inserts the `routine_runs` row (`queued`, `scheduled_for`), inserts the hidden `work` task (`routine_id`, `kind='routine'`, saved instruction plus a framing block: "This is a scheduled run, not a user message. Quiet rule: ..."), and updates `next_run_at`. Hidden means: the task and its tool steps appear in the Routines run history, and only the final user-visible message (if any) is posted to the chat. The run row is updated by the task-complete hook (`succeeded`, `failed`, `skipped`, `summary`). Overlap policy stays `skip`, now written as a run row with `skip_reason='previous_run_active'`.

### 4.9 Quiet rule per run
The saved instruction ends with a delivery line ("Tell the user in this chat. If nothing changed, reply NOTHING_NEW."). The worker recognises that sentinel (and empty output): the run is recorded `succeeded` with `notified=false` and no chat message or push is sent. Change-only watches (`http`, `memory`) keep skipping the model entirely when unchanged.

### 4.10 Failure and missed runs
- Missed (API or host down): on start, for each enabled routine with `next_run_at` in the past, run **one** catch-up if the missed time is within a window (default 6 h for recurring, 24 h for once), otherwise record `skipped` with `skip_reason='missed'`; never replay every missed slot. Then compute the next time from now.
- Failed run: increment `failure_streak`; After 3 consecutive failures, or one auth failure repeated, set `enabled=false`, `paused_reason`, notify the user in chat with what to fix. A success resets the streak.
- Long absence: if the user has not opened the app for 14 days, ask once in chat whether to keep routines running, then pause (Grok Bot does this, https://cursor.com/docs/grok-bot/work).
- Expiry: `expires_at` reached deletes or disables the routine after one last run.

### 4.11 Right panel (read-only plus toggle)
Row: name, schedule in words with zone, next run (or "Paused"), Switch in the bot's accent colour (already built in `routines-section.tsx`). Click opens a drawer: instruction text, trigger, last 20 runs with status and skip reason, buttons Pause/Resume, Test (real run, warns), Edit (inserts "Edit your routine: <name>" into the chat composer), Delete (confirm). Empty state: "Ask in chat to set a routine". No create form.

## 5. Tests
Unit (C#): zone-aware `Cron.Next` including DST gap and overlap; minute-phase rules; 5-minute floor; jitter determinism and bounds; one-off fires once; missed-run policy (one catch-up, rest skipped); failure streak pause at 3; quiet sentinel; per-bot cap; idempotency; update requires prior get; peer-origin runs forced to Ask. Integration (Python, mock model): "remind me every morning" yields a create_routine call with the user's zone and an approval card; Approve creates it, Deny does not retry; "change it to 9" yields get then update; "stop it" yields pause; scheduler double instance fires once (SKIP LOCKED); run row ends `succeeded`. Web (Playwright): toggle persists and uses the bot accent colour, skeleton/empty/error states, drawer history, no create form. Eval: 20 phrasings ("daily check", "weekdays at 9", "in 45 minutes", "tell me when X") scored on schedule correctness.

## 6. Build order (estimates)
1. Timezone: user setting plus zone-aware `Cron.Next` everywhere, tests. About 1 day.
2. `RoutineService` shared by bot tools and HTTP, 5-minute floor, caps, validation (also fixes the HTTP gaps). About 1 day.
3. Tools get/update/pause/resume/delete with approval-card text and diff; tool descriptions and injected local time rules. About 1.5 days.
4. Run lifecycle: update `routine_runs` on completion, skip reasons, history endpoint, prune to 20, SKIP LOCKED. About 1.5 days.
5. Quiet rule plus hidden-turn framing and one-off reminders. About 1.5 days.
6. Jitter, failure streak auto-pause, missed-run catch-up. About 1 day.
7. Panel: drawer with history and Test/Edit/Delete; remove create form. About 1.5 days.
8. Eval set and integration/Playwright tests. About 1.5 days.
9. Later: email, webhook and bot-message triggers. About 3 to 4 days.
Total for steps 1 to 8: about 10 to 11 working days (estimate).
