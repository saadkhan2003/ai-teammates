# arch/resume progress (design section 6)
Done: 0 (cut supervisor/report, attempt log), 1 checkpoint ledger, 2 cumulative budgets, 4 resume brief + unknown_outcome, 5 resume policy/next-message/approval, 6 notices + Continue/Raise/Stop cards, epoch fence on transcript PUT.
Not done: 3 append-only transcript, 7 compaction, 8 watchdog, 9 git snapshot refs, 10 chaos hardening; settings UI for budgets; real kill-worker integration test (lease expiry is simulated via SQL); no server-side dedupe of shell/write_file on idempotencyKey.
Tests (isolated compose project `resume`, ports 48080/48081): C# unit 299, pytest 126, node 41, tsc clean, contract 19 (non-docker), integration test_long_run_resume 9, Playwright long-run-resume 5.
Notes: .compose-resume.yml (untracked) = compose copy with own networks/subnet/ports. tests/integration honour PG_CONTAINER.
