# AI Teammates v0.4 status (2026-10-24, PKT)

Branch `v0.4-codex` (local), base v0.3 `0a8a3fa`. Stack under test: mock stack web :18080 / api :18081. NOT pushed (no credentials, no push to main).

## Done on v0.4-codex
- A-J: reliability, computer (F), reply UX, motion, bot messaging, panel, coding budgets, templates.
- K Coding section; L routines card; M Computer card states; P floating chat pill.
- N1-N8 routines: owner timezone, shared RoutineService, bot tools, run history/quiet rule/one-offs/jitter/auto-pause/catch-up, drawer UI.
- O1-O10 Library: Today / This week / Older groups, thumbnails, safe preview dialog (path jail + DLP), hover actions, search and type filters, keyboard nav, share links with public `/s/` page, coding diff and office kinds (migration 026).
- Last fix (e08797c): hover and preview state were one variable (focus opened the dialog); the preview dialog was not mounted in search mode.
- Docs: routines, library, long-run resume, memory notes and voice designs, DECISIONS_DEFAULTS.

## Tests (run 2026-10-24 ~02:35-02:50 PKT on HEAD e08797c)
- C# unit 288/288, compute-contract 19/19, pytest unit 113, node 36, tsc clean.
- Playwright (all_clean, split batches): 67/67 (desktop 15+35+12, iphone-13 3, pixel-7 1, android-360 1).
- Integration: 57 passed, 4 failed in one full run. 2 are test_computer_network (shared docker network with another worker's stack), 1 login 429 (passes alone), and test_v03 yaml_outbound fails alone too: `/api/admin/outbound-actions` is LIMIT 50 and newest-first, so the e2e delete rows crowd out the plugin_write row (test/env issue, not product).

## Known gaps
- Push blocked. Computer thumbnails unverified live (computer-image not rebuilt; no LibreOffice, so no Office thumbnails).
- Library: Page kind has no producer; "Manage files" upload section is still under the list; mock "spreadsheets" icon shows `?`.
- vnc-lifecycle is order-dependent. K/L/M/P/N commits are not individually compilable.
- run_tests auto-runner detection incomplete; messaging attachments and resource_yield not done; blank-recording check can false-positive; editor deep links only unit-tested.
- No ScheduleNormalizer for `*/N`, no `@hourly`/`@every`; N step 9 event triggers skipped by instruction; no local-time injection into the worker prompt.
- Voice design is docs only. Long-run resume and memory/rules are NOT merged here: moved to arch/resume and arch/rules workers. Unmerged earlier Codex work exists on v04w/lr-1 (includes mem-1 merge, unit 309 passing, never run end to end).

## Screenshots (../shots)
10-routines-on/off, 11-library-o3, 12-computer-card (+waking/offline/error/full), 13-chat-pill, 8-bot-messaging, 9-computer-side-by-side (design-ref left; right frame caught mid-fade in the mock).

## Export
../export/v0.4-codex.bundle, ../export/patches/*.patch (0a8a3fa..HEAD), ../export/v0.4-patches.tar.gz.
