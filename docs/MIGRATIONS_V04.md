# v0.4 merge migration plan (pending implementation)

The ordered merges and renames have **not** been applied. The execution sandbox
currently mounts this worktree's Git metadata read-only, so the first commit and
`git merge --no-ff arch/resume` failed before changing HEAD. This mapping records
the dependency review for continuation; it is not a description of the current
schema. Migrations 001–026 stay unchanged. Reserve 090–099 for later merges.

| Branch | Original migration | Planned merged migration |
|---|---|---|
| rules | 027_memory_notes | 027_memory_notes |
| resume | 028_long_run_resume | 028_long_run_resume |
| resume | 029_resume_timing | 029_resume_timing |
| resume | 030_tool_dedupe | 030_tool_dedupe |
| resume | 031_pause_on_budget | 031_pause_on_budget |
| resume | 032_transcript_archive | 032_transcript_archive |
| resume | 033_watchdog | 033_watchdog |
| rules | 030_approval_rules | 034_approval_rules |
| gaps | 020_approval_rules | Fold into 034_approval_rules; no second table |
| rules | 031_rule_scope | 035_rule_scope |
| companion | 032_device_commands | 036_device_commands |
| gaps | 019_computer_windows | 037_computer_windows |
| gaps | 021_desktop_lease | 038_desktop_lease |
| gaps | 022_tickets_state | 039_tickets_state |

The implementation must list every SQL file exactly once, in this order after
026, in both `apps/api/Dockerfile` and `Platform.MigrateAndSeed`. The tickets
migration depends on the desktop lease migration. Its table/index creations and
`ADD COLUMN release_after`, and the desktop lease table/index creations, currently
lack `IF NOT EXISTS`; review those for safe repeated application as required.

Approval reconciliation must retain rules' owner/bot scoping, editable narrow
matchers, revocation, never-allow action classes, peer-origin exclusion, use
counts and audit events. Also retain gaps' rejection of shell syntax/expansions
for remembered commands and its rule that an explicit personal Ask cannot be
overridden. Consult remembered rules only after PolicyGate, reviewer, credential
domain checks and model labels have completed. Replace gaps' separate
`action/shape_hash` SQL reads and inserts with the unified feature; merely keeping
both `CREATE TABLE IF NOT EXISTS` files leaves incompatible column expectations.

Continuation also needs to preserve gaps' feedback delivery fix: claim feedback
at lease time, consume it only after the transcript is durable. Its final branch
already contains this fix and computer/tool readiness fixes described in
`docs/ARCH_G3_STATUS.md`; do not accidentally replace them with the older paths
when resolving conflicts.
