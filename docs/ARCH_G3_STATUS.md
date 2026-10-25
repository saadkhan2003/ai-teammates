## G3 live acceptance results (archgaps stack only, Oct 24 2026, Asia/Karachi)

Historical, chronological test record for the `archgaps` worktree. Failures, open items, and environment details are scoped to the dated runs below; later entries in this file record follow-up changes, and none of these results certify the current integrated tree.

Commits: 7119d65 (DbClock, ticketed-control test), 7a07333 (pids 1024), 42bfffd (NO_PROXY loopback, /continue), 725fe38 (COMPUTE_STACK scoping).
Real bugs found and fixed: vnc-ticket/human-input 500 (DateTime->DateTimeOffset), Chromium starved by pids=256, computer Playwright blocked by egress proxy for loopback CDP, and the archgaps API adopting/counting the live `teammates` computers because Reload() listed every `teammates.managed` container on the shared daemon (now scoped by teammates.stack label; live stack containers are unlabeled and unchanged). The live stack was never modified.

Results (honest):
- Unit: 226 passed, 1 skipped, 0 failed.
- Integration `test_acceptance.py` (acc8, log wt-logs/acc8.log): FAIL. Gets through bot creation, secrets, browser burst, parallel browser, code-fix, ticketed take-control and hand-back, then fails at "Hidden feedback" never appearing in task_transcript. Cause (unverified): feedback is marked consumed at lease time (apps/api/Routes.cs ~1028); the artifact task ran with attempt=2, so attempt 1 consumed the feedback and died before persisting a transcript, and the retry loaded an empty-of-note transcript. Likely fix: re-deliver feedback where consumed_at IS NULL OR task_id = this task.
- Rest of integration (wt-logs/integ-rest.log): 26 passed, 2 skipped, 6 failed. Failures: test_bot_messaging x2 (tasks timed out), test_computer_network (URLError vs expected 'open ' message), test_computer_recovery (tool call did not finish), test_stdio_sandbox (401), test_workspace_isolation ("desktop not ready" 404 on computer API). Not root-caused; several likely share one cause (computer/tool tasks stalling).
- Playwright and dedicated leak suite: NOT run in this pass.
- Postgres ticket/lease store tests (.NET, G1): passed earlier in G1; not rerun here.
Still open: I1 (gVisor/Firecracker, laptop); Cloudflare dashboard setup is manual; SSE buffers per API instance; IPv6 untested in nft probe; unit tests are sensitive to exported STACK/ISOLATION_CHAIN (run with env -u); acceptance needs DB+computer reset between runs. KVM: /dev/kvm works nested; ~6 microVMs at 2 GB fit; full 8vCPU/16GB spec does not.

## arch/gaps follow-up (2026-10-24, archgaps stack)
- Product fixes: lease re-delivers feedback until the transcript is persisted (6adf2b8, 6c9bdc4); the reviewer no longer overrides an explicit user ALLOW for message_bot (7520b75); the agent lease loop survives an API restart instead of exiting on TransportError (77c8cb6).
- Test fixes (stale tests or environment): stdio port, workspace-isolation fence/uid, recovery auto-approver, egress default-deny, the network guard picking another stack's container (9e46dbd), auto-approver login retry (24a8e3e).
- Integration: integ-full8 30 passed, 3 failed, 2 skipped. The 3 bot_messaging failures did not reproduce: 3/3 alone, 3/3 after an API restart, 10/10 acceptance+bot_messaging in one run. Treated as an unexplained timing flake.
- acc9b: 1 passed (reset DB/computers).
- Playwright: 27/54 passed on the first run, mostly login 429 (30 logins per IP per 10 min, successful ones included). With the limiter table cleared, the 27 re-ran: 11 passed, 16 failed (9 stuck on the login page with no error, several "task could not finish"). Not yet triaged.
- Reset between runs must also clear login_rate_events, credential_domain_grants and approval_rules, and stop api/agent first.

## Playwright on archgaps, pw9 (2026-10-24, HEAD before d699fed)
49/54 passed, 5 failed.
- acceptance #9 code agent: edit_file approval not auto-allowed (test). Fix committed in d699fed, not re-run yet.
- security login form: request_login still sees "You're in control" (DESKTOP_BUSY). Open; the lease was free once the run ended.
- mobile ×3 (iphone-13, pixel-7, android-360): an approval inserted with no task_id does not render a send_email approval card. Open.
Fixed this round: teach hand-back now goes through the pane's lease-aware handBack, and the API returns 400 instead of 500 for a missing body (product); the fullscreen attention banner no longer covers Stop on phones (product); globalSetup sets the egress policy; settings-computer uses anonymous storageState.

## pw10 / pw11 (2026-10-24, PKT)
- pw10 51/54, pw11 51/54. Mobile seed fixed (test), lease auto-claim fixed (product, 0368331), acceptance #9 passes.
- security: direct extract needed fenced actor/epoch (test fix ddc9401). It passes alone; in the full suite browser_open into the computer hangs ~2 min after private-hosts (cause open).
- acceptance #17: backup/restore scripts were hardcoded to teammates-postgres-1 (the live stack); fixed to $STACK in 1132e81, and restore_check now passes on archgaps. pw10/pw11 ran pg_dump plus the agent_restore DROP/CREATE against live postgres; the live agent DB itself was not modified.
- pw11 settings-computer: the owner login was rejected (new, uninvestigated).

## pw12-pw24 (2026-10-24, PKT; DB/log times UTC)
- pw12 52/54, pw17 53/54, pw20 45/54, pw22 53/54. security.spec alone: 3/3 (pw19, pw21), 1/1 (pw23).
- Fixed (test): chat-features hover locator (563cf0d), security extract picks the signin tab (ecd5981), test owner's computer gets 1 CPU (a378728).
- Root cause of the intermittent "~2 min hang" (security CDP connect 114 s in pw22, bot DELETE / POST /api/secrets 20 s timeouts and max_bots cascades in pw20/pw24): containers with a CFS quota (`cpus:` 0.01-0.25 in the stack compose, 0.4 CPU computers) get stuck throttled. Seen live in pw24 on archgaps-postgres-1 (0.2 CPU): cpu.stat usage_usec frozen for minutes while nr_throttled rose every period, one INSERT and nine `runc init` stuck in R, API "Failed to connect to postgres". Writing `max` to its cpu.max unstuck it instantly. Same signature on the computer earlier (runc init in R, /json/version timeouts). Host kernel 6.12.94+; host load was ~1, so it is not real CPU shortage.
- Mitigation for isolated test stacks only: no CPU quotas (gen-stack-compose --no-cpu-limits) and a larger test-owner computer quota. Product sizing (0.4 CPU computers, small service quotas on the live stack) is for Saad to decide.
- agent_restore was not dropped. The live stack was not touched.
- pw26 53/54 (security passed; acceptance takeover failed). Cause: the computer's human click (`human_click`) mapped the button to X screen coordinates with screenX/outerHeight and clicked with xdotool. A background tab reports stale metrics (click lands on the front tab), and after bring_to_front the metrics describe the X frame (shadow included), so the click fell about 30 px below the button. The captcha never cleared and the task stayed waiting_human. Fix: bring the tab to front and click in viewport coordinates over CDP (fcb5fdf, 620d2c4). Verified on the archgaps computer; acceptance 2/2 (pw30).
- pw31 full run 54/54 (2026-10-24 10:47 PKT, HEAD 1a7177c).
