# v0.2 security and login

Historical v0.2 security and login implementation snapshot. Migration behavior, test counts, and known limitations describe that earlier tree, not current upgrade guidance. Use [`docs/SECURITY.md`](SECURITY.md) for current security notes. The three ADR file paths cited in the original v0.2 notes are not present in this repository snapshot.

Policy gate, data checker, hash-chained audit, in-chat login, and a public proxy that does not publish worker routes. The MVP acceptance checks stay in place. Operator notes: [`docs/SECURITY.md`](SECURITY.md).

## What was added

- `PolicyGate` in front of every tool, including unknown plugin tools. Classes: read, write, send_message, payment, sign, delete, credential_use, external_post. Settings → Policy stores ALLOW / ASK / DENY per class. `credential_use` defaults to ASK. Allow once approves that saved credential. "Always allow for this domain" stores the host and skips later asks for it. The vault domain list still has to match. `request_login` without vault refs uses the form as consent. A model label is optional and can only tighten a non-built-in tool.
- Hard deny, even after Allow once: moving money, trading securities, another user's account, disabling audit, exporting the vault. Built-ins live in code. Admins add substring rules. They cannot delete a built-in family.
- Data checker for card numbers (Luhn), CNIC and labeled national IDs, SSNs, passports, IBANs, and API keys. Those are redacted before logging and blocked on the way out. Health and finance phrases need an explicit instruction before a send or a public post.
- Append-only audit with a SHA-256 chain over `chain_canonical`. The test hook checks the links and that canary values are absent.
- `request_login` card: domain, masked fields, optional save to vault. Submit shows Done ✓. The model receives `{status: filled|expired|cancelled|denied}` only. Values are read into `byte[]`, packed, and stored as AES-GCM, single use, about five minutes, then zeroed. The filler body is built from those bytes. The computer types them only when the live origin matches.
- Public Caddy no longer proxies `/internal/*` or `/metrics`. The worker uses `http://api:8080`. Prometheus scrapes that address. `deploy/Caddyfile.test` is opt-in with `ENABLE_TEST_HOOKS`. `deploy/Caddyfile.production` is the Let's Encrypt example: HSTS, a CSP that allows the noVNC WebSocket (`connect-src 'self'` for `/vnc/websockify`), and a 32 MB body limit. Login rate limiting is in the API (8 failures or 30 attempts per address per 10 minutes) because Caddy has no built-in limiter. `X-Forwarded-For` is trusted only from a private or loopback peer.
- The admin app is a second site (`apps/admin`, Compose port `18082`, production host `admin.example.com`). Its Caddy listener proxies `/api/*` and `/health` only. `ADMIN_ALLOWLIST` optionally restricts that listener to space-separated CIDRs. A non-empty `admin_ip_allowlist` table also rejects other addresses on `/api/admin`. The user app has no admin route. Staff roles are owner, admin, support, and read-only.
- `deploy/compose.production.yml` refuses to start without `OWNER_PASSWORD`. The API refuses `teammates-dev` when `REQUIRE_OWNER_PASSWORD=true`. The dev default stays on `docker-compose.yml` for local tests.

## Code paths

- Gate: `apps/api/Policy.cs` `PolicyGate.Evaluate`, called from `Runtime.Authorize` and `Runtime.Execute`.
- Data checker: `apps/api/Dlp.cs` and `OutputRedactor` in `src/Compute.Domain/ComputeModel.cs`. Chat rejection is in `Routes` (`POST /api/conversations/{id}/messages`).
- Audit: `Platform.Audit`, `apps/api/AuditChain.cs`, `db/006_security.sql`, `GET /internal/test/audit-chain`.
- Login: `apps/api/LoginBroker.cs`, `apps/api/LoginFlow.cs`, `services/computer/src/browser.py` `fill_login`, `apps/web/components/login-card.tsx`. The worker stops on `waiting_human` (`services/agent/guard.py` `should_halt`) and later sends only `login_result`.
- Edge: `Caddyfile`, `deploy/Caddyfile.production`, `deploy/Caddyfile.test`, `deploy/compose.test.yml`, `apps/api/LoginRateLimiter.cs`.

## How to test

```bash
make test-unit
make test-integration
cd tests/e2e && npx playwright test acceptance.spec.ts security.spec.ts --project=desktop
cd tests/e2e && npx playwright test mobile.spec.ts --project=iphone-13 --project=pixel-7 --project=android-360
```

`make test-integration` publishes the API on `127.0.0.1:18081` and points worker-token calls at `API_URL`. Public checks stay on `http://127.0.0.1:18080`.

Manual UI, signed in as `saad` / `teammates-dev`:

1. Settings → Policy. Public post stays ASK. The built-in deny list is visible and cannot be removed.
2. Assign `Post this note to the public board: hello from the yard`. Allow once on the `external_post` card.
3. Send `Please file card 4242424242424242`. The data-policy line appears.
4. Assign `Sign in at the portal`. The card shows `portal.example.edu` and masked fields. Submit without Save to vault. The card reads Done ✓. The bot says it signed in. The fixture page says logged in.
5. Assign `Open http://portal.example.edu.evil.test:8099/lookalike.html`. The task finishes denied.
6. `curl -sS http://127.0.0.1:18080/metrics` does not include `teammates_model_calls_total`. With the test override up, `curl -sS -H "Authorization: Bearer $METRICS_TOKEN" http://127.0.0.1:18081/metrics` does.

## Migrations

`db/005_plugins.sql` stays migration `005`, the same file as main. Security is `db/006_security.sql` and credential grants are `db/007_credential_grants.sql`. Those ids do not collide with anything in main's `db/` tree, which stops at `005_plugins.sql`.

Historical pre-rebase failure only: a database from that branch recorded security as migration `005`; the runner then skipped `005_plugins.sql`, leaving `plugins` missing and causing `secrets_type_chk` to reject `PLUGIN_CREDENTIAL`. The original recovery discarded that test volume and rebuilt it. Do not treat this as current migration guidance or run `docker compose down -v` against a data-bearing stack.

The counts below are from one volume created with `docker compose down -v`, rebuilt, and started with `docker-compose.yml` and `deploy/compose.test.yml`. The API runner applied `001` through `007`. Nothing was patched with psql.

## Test counts

| Suite | Result |
| --- | --- |
| `dotnet test tests/unit` | 84 passed, 0 failed, 0 skipped |
| `pytest tests/unit` | 32 passed, 0 failed |
| compute contract, fake provider | 14 passed, 0 failed, 0 skipped |
| compute contract, `COMPUTE_CONTRACT_DOCKER=1` | 26 passed, 0 failed, 0 skipped |
| `pytest tests/integration` with `API_URL=http://127.0.0.1:18081` | 10 passed, 0 failed, in 119.06s |
| `npx playwright test acceptance.spec.ts security.spec.ts --project=desktop` | 2 passed, 0 failed, in 2.3m (items 1–22, then the security spec) |
| `npx playwright test mobile.spec.ts` on iphone-13, pixel-7, and android-360 | 3 passed, 0 failed, in 26.0s |
| `npx playwright test question-card.spec.ts` on desktop and iphone-13 | 2 passed, 0 failed, in 10.9s |
| `node tests/e2e/visual.mjs` | 114/114 shots |
| `vnc-lifecycle.spec.ts` with `CYCLES=20` | 1 passed, 0 failed, in 35.8s |

The integration file includes the missing-container regression and the computer-network check. Clear `credential_domain_grants` and the owner's bots before a repeat browser run. A domain grant skips the saved-credential approval the acceptance check waits for, and the bot quota is 8. A database from the pre-rebase branch still needs `docker compose down -v` even after those rows are cleared.

## Screenshots

- `docs/evidence/classifier-approval.png` — external post approval card
- `docs/evidence/dlp-block.png` — data-policy block
- `docs/evidence/login-before.png` — login card before submit
- `docs/evidence/login-after.png` — Done ✓

## Known limitations

- Login values on the API path are `byte[]` buffers, packed and encrypted, then zeroed. Residual copies can remain in the Kestrel connection buffer and in `ByteArrayContent` until those buffers are reused or disposed. Kind names, the domain, and selectors are strings. The computer is Python: `fill_login` needs a `str` for Playwright, and that string cannot be wiped. It is dropped when the function returns and is not logged. Values are written to disk only when Save to vault is ticked.
- The login broker and idempotency keys are in-process. An API restart drops a pending fill.
- Model assist is off by default and only runs for unknown tools. `credential_use` defaults to ASK. A domain grant skips later asks for that host. The vault domain list still has to match.
- `external_post` does not call a real site. After approval it returns held.
- `transfer_funds` is denied by the gate if a model emits it. It is not offered as a normal tool.
- `deploy/Caddyfile.test` publishes `/internal/*` and `/metrics`. Do not use it on a shared host. The default compose file does not publish `18081`.
- The audit verifier hashes the stored `chain_canonical` string, so older rows do not depend on reformatting timestamps in C#.
- An API restart reloads computers from the Docker labels `teammates.managed=1` and `teammates.computer_id`. After a restart here, view-token and a shell task both reached the container that was already running, so the in-memory inventory did reload. VNC stayed disconnected, and some tool calls returned "computer not found", only while that container was overloaded: `/metrics` showed 22 Chromium processes and about 2.6 GB, and `POST /desktops/{id}/viewer` returned 500 because the view server never opened its port. A fresh computer passed the desktop and phone checks. `apps/web/components/computer-pane.tsx` is main's full-window desktop. A VNC reconnect retry was not added.
- A missing computer container is resolved on main. `DockerComputeProvider.DemandAsync` treats a Docker 404, or a container that is no longer running, as gone. It drops the in-memory row and signals recovery. The tool route returns HTTP 503 `computer_recovering`. The worker raises `ComputerRecovering` and the task waits while the computer is rebuilt under the same id, so `user_computers` and `PlacementForBot` keep resolving it. `tests/unit/test_computer_recovery.py` and `tests/integration/test_computer_recovery.py` cover that path.
