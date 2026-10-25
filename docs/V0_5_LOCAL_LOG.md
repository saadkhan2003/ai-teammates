# v0.5-local log (2026-10-25)

Historical implementation and validation snapshot for the `v0.5-local` branch and isolated `v05` stack. Its test outcomes, performance figures, screenshots, and follow-ups are scoped to that run, not current integrated-tree status.

Branch `v0.5-local`. Built on the isolated `v05` stack (port 46080) with `LLM_PROVIDER=mock`. No live stack, no real provider.

## Scope delivered
- Merged `briefs` and `speed`.
- 409 fix.
- Live job log view: SSE `/api/jobs/{id}/log/stream`, auto-scroll, Pause/Resume. Reading it never wakes the desktop.
- Headless computers: the desktop sleeps until Watch or Take control. The idle reaper puts it back to sleep, and waking restores the supervised X services.
- Review fixes:
  - No raw JSON in chat.
  - Admin spend shows owner and bot names (short ids as chips) instead of UUIDs.
  - A usage-pause reply points to the usage note once. The worker gate deny keeps its `usage_limit` code.

## Tests (all niced, one heavy job at a time)
| Suite | Result |
|---|---|
| C# unit | 728 passed. No C# changes after this run. |
| Compute contract (non-Docker) | 30 passed |
| pytest unit (after the last worker change, clean env) | 452 passed, 1 skipped |
| Web node tests | 77 passed |
| tsc web / admin | 0 / 0 |
| Integration | 119 passed, 2 skipped. 3 first-run flakes passed on re-run. The credits failure was fixed (worker kept the gate code) and passes. |
| Chaos | 6 passed |
| Playwright (44 spec files, workers=1) | Full run: 93 passed, 6 failed, 2 skipped. Re-run of the 6 failing specs after test fixes: 21/21 passed. |

Known flaky (passed on re-run, no product change):
- e2e `computer-jobs` live log: under full-suite load the log did not overflow its box within 60 s. It passes in 32 s alone.
- e2e `settings-computer`: `page.goto` got `ERR_ABORTED` right after login.
- Integration `test_acceptance_suite` (EVIDENCE DEMO timeout).
- Integration `test_removed_stopped_computer_stays_stopped_until_asked`.
- Integration `test_browser_origin_requires_allow_once_on_each_run`.

e2e test fixes:
- approval-rules waits for the decide response.
- acceptance wakes the computer before reading memory.
- computer-card pins the desktop probe to asleep, because the computer is shared and an earlier spec can leave it awake.
- chat-features waits for the message before selecting text.

## Perf (`perf-speed`, mock, 10 runs, ms)
`before` on v04b could not be measured. The old UI does not emit the composer echo/ack signals the spec needs ("Missing send measurements: echo_ms,ack_ms"), so it has no numbers.

`after` on v05:
| Metric | p50 | p95 | Target p95 |
|---|---|---|---|
| echo | 45 | 51 | 100 |
| ack | 71 | 124 | 1500 |
| first token on screen | 1930 | 2286 | 2000 (over) |
| tool chip | 170 | 456 | 600 |
| chat switch | 58 | 123 | 200 |
| cold chat switch | 92 | 143 | – |
| LCP | 110 | 254 | 2500 |
| INP proxy | 32 | 44 | 200 |

First-token p95 is over target. DLP buffers until a sentence boundary, so first paint waits for one.

## Measured memory (docker stats, per computer, 640 MiB limit)
- Headless idle: 95.9 MiB (0 Chrome / desktop processes).
- Desktop on: 381–398 MiB (9 Chrome, 16 desktop processes).
- Back asleep after use: 147 MiB.
- Saving: about 290 MiB (about 75%) per idle computer that was never watched, and about 240 MiB after a watch session ends.

## Screenshots
`/workspace/shots-final/v05/`, 14 PNGs, light and dark, retaken at 10:54 PKT:
- admin AI models
- admin computer health
- admin spend
- chat job started
- computer jobs
- job live log
- panel desktop asleep

The earlier 04:01 set is kept in `pre-0401/`.

## Follow-ups
- The admin spend card still prints the caps object as raw JSON (`{plans, users, bots}`) under the table. This is admin-only and pre-existing.
