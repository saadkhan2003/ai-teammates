## G3 live acceptance results (archgaps stack only, Oct 24 2026, Asia/Karachi)
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
