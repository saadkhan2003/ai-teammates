# v0.4 migrations

Migrations 001–026 from base 392f23e are unchanged. Incoming migrations are
linear and unique, 027–042, including Skills v2 and Video v1.
Platform.MigrationFiles and the API Dockerfile contain each SQL file once.
Each migration after initialization commits atomically with its tracking row.

| Original migration | Final migration |
|---|---|
| 027_memory_notes.sql | 027_memory_notes.sql |
| 028_long_run_resume.sql | 028_long_run_resume.sql |
| 029_resume_timing.sql | 029_resume_timing.sql |
| 030_tool_dedupe.sql | 030_tool_dedupe.sql |
| 031_pause_on_budget.sql | 031_pause_on_budget.sql |
| 032_transcript_archive.sql | 032_transcript_archive.sql |
| 033_watchdog.sql | 033_watchdog.sql |
| 020_approval_rules.sql | 034_approval_rules.sql |
| 030_approval_rules.sql | 035_approval_rules_upgrade.sql |
| 031_rule_scope.sql | 036_rule_scope.sql |
| 032_device_commands.sql | 037_device_commands.sql |
| 019_computer_windows.sql | 038_computer_windows.sql |
| 021_desktop_lease.sql | 039_desktop_lease.sql |
| 022_tickets_state.sql | 040_tickets_state.sql |
| 090_skill_library.sql | 041_skill_library.sql |
| 095_video_analyses.sql | 042_video_analyses.sql |

The unified approval table is created at 034, upgraded at 035 (also supporting
historical layouts). Memory rule scopes at 036 follow memory notes at 027. Tickets at 040 depend on desktop
leases at 039. Overlapping table/index/column creation is idempotent.

Only 001–026 are supported as previously applied base migrations. Databases
that applied unmerged branch migrations with conflicting IDs must be backed up
and reconciled against this mapping before upgrading; an ID alone cannot tell
which branch schema was installed.

Skills v2 at 041 adds `skill_library` and `skill_revisions`; the original replay
`skills` table and task references are preserved. The pre-merge skills ID 090
is not a supported applied migration; reconcile it with this mapping before upgrading.

Video v1 at 042 adds an owner/bot/source/hash/settings-scoped analysis cache
and task/bot/epoch-bound policy-authorized video invocation sessions.
The pre-merge video ID 095 must be reconciled before upgrading, as with 090.
