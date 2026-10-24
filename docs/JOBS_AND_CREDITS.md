# Background jobs and the unified usage meter

## Background jobs (bot computer)
Bots start long commands with `job_start(command, name?, max_minutes?)` and check them with `job_status`, `job_logs` and `job_cancel`.
- **Record.** Each job is a row in `computer_jobs` (db/046). It holds the pid, start time, max run time (seconds), status (starting, running, done, failed, timed_out, cancelled), exit code, log path and result path. The files live under `$BOT_ROOT/jobs/<id>/` on the computer: `log.txt`, `result/` (exported as `$JOB_RESULT_DIR`) and `exit_code`.
- **Max run time.** It comes from the plan: `job_default_minutes` when the bot does not ask, clamped to the range 0.5 to `job_max_minutes`. Standard is 60 minutes by default and 240 at most; Pro is 120 and 720. The command runs under `timeout -s TERM -k 10`. Running jobs per owner are capped by `max_running_jobs`. Per-computer RAM/CPU limits are unchanged, because jobs run inside the bot's own computer.
- **Idle sleep.** `SuspendIdle` treats a computer as busy while any of its jobs is starting or running, so the screen can idle while the work continues.
- **Done/failed.** The API watcher (every ~6 s) probes the exit file. On an outcome it posts a plain chat message in the bot's conversation ("Background job “X” finished in 1m 5s. Results are in …"), publishes a `job` event and writes an audit row `job.<status>`. It does not re-wake the bot automatically.
- **Safety.** `job_start` is a Write tool. It gets the same PolicyGate, risky-shell review and agent pre-exec check as `shell`, and it is never replayed on resume. Log output reaches the model fenced as untrusted ("job log").
- **Lazy wake.** Routines and peer tasks no longer eager-wake the computer when leased. The computer wakes on the first tool that actually needs it (`ComputerNeed.Needs`), so routines that only chat or read memory never wake it.
- **UI.**
  - The computer view shows a "Working in background · N jobs" pill when jobs run and the screen has not been used in the last 90 s.
  - It shows a live jobs list with elapsed time, status, and Stop with a confirm step.
  - Clicking a job opens a read-only log tail (`<pre>`, refreshed every 3 s while running).
  - A subtle "Screen last used N min ago" note sits beside the pill.

## Unified usage meter (credits)
Everything converts to credits at real cost (db/047). The defaults below are **estimates** from the cost Page:

| Source | Rate |
|---|---|
| AI | model cost charged ÷ `usd_per_credit` (default $0.001 = 1 credit) |
| Computer | 0.1 credit per awake minute, including background-job minutes (sampled every ~20 s, one row per computer-minute) |
| Storage | 5 GB free, then 50 credits per GB-week (daily samples) |

Plans (`billing_plans`, editable in Admin → Billing):

| Plan | Price | Weekly credits | On-demand cap | Job default/max | Running jobs |
|---|---|---|---|---|---|
| Standard | $30 | 4,500 | $100/mo | 60 / 240 min | 3 |
| Pro | $100 | 16,000 | $300/mo | 120 / 720 min | 6 |

Standard: a heavy user capped at 4,500 credits a week costs about $19.5 a month in real cost plus about $2 in payment fees, against $30 in revenue (an estimate). The typical user is about 2,750 a week (61%).

- **Window.** The week is anchored on sign-up (`usage_anchor` or `created_at`). "Resets in N days" is shown to the user.
- **At 100%** with no on-demand limit, or with on-demand spent, heavy work is paused:
  - new jobs and any tool that needs the computer are denied with code `usage_limit`
  - waking the computer (lease, terminal ticket, VNC) returns 402
  - chat still answers
  - the bot posts one message per task explaining how to top up (Settings → Usage & Billing → on-demand limit, or upgrade)
  - An already-awake computer keeps running its current tools; only new jobs are blocked.
- **On-demand.** The monthly limit is None by default, or $10/25/50/100… up to the plan cap. Pay-as-you-go overage is recorded per window in `credit_windows`. **No payment is processed.** On-demand changes and upgrade requests are only audited (`charged=false`).
- **Admin → Billing** edits rates and plans, assigns plans, and shows the per-user breakdown: AI, computer, storage, used/allowance, awake minutes (background), on-demand and state.
- The user app never shows model or provider names. The usage page shows only AI / Computer / Storage credits.
