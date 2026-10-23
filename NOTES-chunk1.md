Chunk 1 integration notes:
- Reliability migration uses db/012_reliability.sql because chunk 3 already created db/011_devices.sql. API Platform applies 012; API Dockerfile copies it and embeds the new workspace shell helper. Chunk 3/orchestrator must register/copy 011_devices separately (not edited here).
- Agent Dockerfile includes grounding.py and retry.py. Rebuild API and agent before running the live suites.
- GET /api/system/llm-status: {hasKey, provider, model, secretId}. Never returns a key.
- Tasks and workspace task rows now include error and errorCode. GET /api/tasks/{id}/log provides durable grounding/error/resource_resumed events. SSE grounding shape is {type:'grounding',taskId,detail:{verified,removed}} (including checks that triggered correction).
- New browser origins require Allow once / Deny per task, including the local portal fixtures. Existing integration/e2e scenarios that assumed fixture exemptions need to approve browser_open before waiting for completion. Added tests/integration/test_reliability_v04.py exercises two-run approval, no-key resume, key rotation/status, and error logs; requires mock stack and test hooks.
- No persistent browser grant was introduced. Existing allow_domain remains credential-only.
- Shell mapping applies to the API agent shell/setup_env paths. Computer service direct shell endpoints are outside this chunk; preserve per-bot UID confinement there.
- Installer helper waits at most ~60 seconds plus bounded request time for stack availability; rerun install.sh with OPENROUTER_API_KEY in environment after stack startup if needed. Existing secrets are left alone. Script output never includes request/response bodies or credential values.
- Plugin idempotency retry contract is documented in docs/SECURITY.md. A remote endpoint must acknowledge the exact outbound Idempotency-Key and actually guarantee replay safety; otherwise transient writes are not retried. Both Python and persisted ledger enforce at most three retries.
- Live Docker/integration/e2e execution deliberately left to orchestrator. No Docker daemon, firewall commands, real keys, or paid APIs accessed.

Verification:
- dotnet test tests/unit/Teammates.UnitTests.csproj --no-restore -v quiet: 151 passed, 0 failed.
- python3 -m pytest tests/unit --ignore=tests/unit/test_computer_displays.py -q: 83 passed, 0 failed.
- Full Python unit collection/run: 83 passed, 6 setup errors in the parallel chunk's test_computer_displays.py because uvicorn is not installed in this sandbox. No computer files or dependencies changed by this chunk.
- New live regression file: 3 tests collected successfully; not executed against a live stack.
- bash -n scripts/install.sh, Python compilation, and scoped git diff --check passed.
