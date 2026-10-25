# Chunk c5 report: rows 6, 7, 8 and lease follow-up
> Historical handoff for `Chunk c5 report: rows 6, 7, 8 and lease follow-up`. Status, implementation details, test results, and open items below describe that workstream's recorded checkpoint; verify the current source and guides before treating them as current.


Completed the follow-up gaps: RW WebSocket close grace releases the durable lease and fences/stops RW VNC; lease changes kick stale sockets; owner force release requires a reason and is audited; second tabs remain view-only until “Take over here”; shell, setup-env and CDP effects carry actor/epoch through the final service fence; process-group cancellation drains then SIGKILLs; restart reconciliation clears held inputs; and the seeded invariant model runs 2,000 interleavings. Migration is now `db/021_desktop_lease.sql`.

Files: `apps/api/{DesktopLeases.cs,Dockerfile,Platform.cs,Routes.cs,Runtime.cs,VncTickets.cs}`, `apps/web/components/computer-pane.tsx`, `db/021_desktop_lease.sql` (removed 019 path), `services/computer/src/{browser.py,desktop_fencing.py,server.py}`, `src/Compute.Docker/DockerComputeProvider.cs`, `tests/unit/{VncTicketTests.cs,test_computer_displays.py,test_desktop_fencing.py}`.

Validation: C# 212 passed; Python 136 passed, 1 skipped; web TypeScript check and `git diff --check` passed. PostgreSQL integration was skipped because `postgres`, `pg_ctl`, and `initdb` are unavailable; memory CAS and SQL assertions passed. Existing unrelated BotMessaging nullable warnings remain. Tickets remain hashed, single-use, short-lived and lease-bound; force-release reasons are bounded and redacted before audit. No git write/commit was attempted.
