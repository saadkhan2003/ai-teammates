# v0.5 plan: SaaS foundation

Status: proposal. No dates are promised. Effort: **S** = days, **M** = 1-2 weeks, **L** = more than 2 weeks.

Sources: `README.md`, `docs/V0_4.md`, `docs/SECURITY.md`, `docs/COMPANION.md`, `db/001`-`014`, `apps/api`, `src/Compute.*`, `scripts/backup.sh`, and `/workspace/research/RAKAZO_STUDY.md` (ideas only; Rakazo is Apache-2.0, so credit it if any code is ported). The README and docs say "SaaS later" but give no plan or version number. This theme is a proposal.

## 1. Goals

Take v0.4 from "self-hosted, one trusted operator" to "a hosted service where unrelated customers share infrastructure safely".

1. A missed `WHERE owner_id` cannot leak another tenant's data.
2. Anyone can sign up, verify their email, create an organization and invite members.
3. Each tenant has plan limits and a spend cap, enforced by the server.
4. Computers run on a provider that can scale past a single Docker host.
5. Operators can back up, monitor, rate-limit and shut off abuse.
6. The v0.3/v0.4 loose ends are finished.

Non-goals: mobile apps, voice, messaging channels, and choosing prices. Plans below have named limits and no prices.

## 2. Starting point (verified in the repo)

- **Tenancy is user-level and enforced in API code.** `bots.owner_id` references `users` (001). `user_quotas`, `user_computers`, `devices` and `login_prompts` are keyed by user. Tables such as `messages`, `memories` and `artifacts` reach the owner only by joining through `bots`/`conversations`. `model_calls` and `outbound_actions` carry a nullable owner id.
- **No RLS and no organization.** `db/*.sql` has no `ROW LEVEL SECURITY` or policy statements, and no org/team table. Roles are `owner`/`admin`/`member` per user (003). The compose file connects the API to Postgres as `POSTGRES_USER` (default `agent`), the same role that owns the schema.
- **No email on users.** `users` has `username` and `password_hash`. `email` exists only on `invitations`. The README says email verification is not in this build. There is no signup route; accounts come from the seeded owner and invitations.
- **Encryption at rest covers secrets only.** AES-256-GCM with one master key in a Docker secret file. `messages.content`, `task_transcript.content` and `memories.content` are plain `text`. `memories_fts` is a GIN index on plaintext.
- **Quotas exist.** `user_quotas` holds max bots, computers, memory, CPU, disk, parallel tasks and secrets. `model_calls.cost_usd` is recorded per owner and `GET /api/usage` sums it. I found no spend cap or plan table.
- **Compute.** `IComputeProvider` has lifecycle, exec, desktop session, snapshot/restore, capacity and health methods. `DockerComputeProvider` is the only runtime. `COMPUTE_PROVIDER=docker` is the only accepted value and `remote` is reserved. `contracts/proto/compute/v1/compute.proto` is linted but not served. Computer isolation is a host firewall script (`deploy/computer-isolation.sh`) and per-bot Linux UIDs.
- **Ops.** `scripts/backup.sh` runs `pg_dump` into `backups/` and checks the master key is not in it. `scripts/restore-verify.sh` restores and checks the key. `/metrics` exists behind a token. Login attempts and device pairing are rate limited in memory and reset on restart.

## 3. Workstreams

### A. Multi-tenant isolation (L, first)
- Introduce a tenant id (organization, see B) and add it to every content table, including the tables that today reach the owner only through joins. Backfill each existing user as a one-user org.
- Add a second Postgres login that is not the schema owner and cannot bypass RLS (Rakazo does this with `rakazo_app`). The API and worker connect as this role. Migrations keep the owner role.
- Enable RLS and policies on every tenant table. Each request or job sets a tenant setting (`SET LOCAL`) inside its transaction. A background job runs as the row's tenant.
- Cross-tenant test suite in `tests/integration`: for each table, a query without a tenant filter returns no foreign rows. Add a CI check that fails when a new table lacks a policy.
- **Per-tenant keys:** wrap a data key per tenant with the master key (the secrets design already binds associated data to owner and key version). Support rotation and a key-version column.
- **Content encryption at rest** for `messages`, `task_transcript`, `memories` and artifacts. Decision needed first: `memories_fts` and embeddings read plaintext today, so either keep search over decrypted data in the API, or accept that those two columns stay plaintext. Do not claim "everything is encrypted" until this is resolved.

### B. Accounts, signup, organizations (M-L)
- `email` (unique, normalized) on users; email verification with a single-use hashed token and expiry, matching the device-pairing pattern (hashed, single-use, rate limited).
- Signup route, with an operator switch (open, invite-only, allowlist). Password reset. Session list and revoke.
- `organizations` and `memberships`; migrate the current `owner`/`admin`/`member` roles into org-level roles; invitations attach to an org.
- Decide how the one-computer-per-user rule (003, README) becomes per-org, and what happens to bots created before the change.
- Outbound email provider (SMTP or API) with a bounce/complaint path. Pick the provider in milestone 1.

### C. Billing and usage metering (M-L)
- `plans` table with named limits, no prices: max bots, computers, parallel tasks, disk, monthly model spend, monthly task count. Reuse the `user_quotas` columns as the first set of limits and move them to org/plan scope.
- Usage ledger built from `model_calls`, task counts and computer-hours. Make it append-only and idempotent.
- **Per-tenant OpenRouter spend caps.** Today the key is per owner (`secret://openrouter/default`) and the API can read the key's `limit_remaining` (ProviderWire). For hosted use, decide between each tenant's own key (cap enforced by checking recorded `cost_usd` before each call) and a platform key with a per-tenant sub-key. Either way, the API must refuse or queue a task when the cap is hit and show a clear message.
- Payment provider integration (webhooks, plan changes, dunning, cancellation). Provider and pricing are the operator's decision. This plan only reserves the hooks: plan id on org, entitlements check in one place, webhook table with idempotency.
- Usage and plan page in Settings; admin report across tenants.

### D. Hosted compute (L)
- Implement `COMPUTE_PROVIDER=remote` against the checked-in `compute.proto`, served by a separate compute host (the README calls this the "Go host"), so the API no longer needs the Docker socket proxy for computers.
- Add export/import of a workspace to the provider contract (Rakazo idea #11) so a computer can be hibernated to object storage and restored on another host. A shared conformance test suite runs against Fake, Docker and Remote.
- Per-tenant quotas enforced by the host (CPU, memory, disk, count), plus a scheduler that places computers using `GetCapacityAsync`.
- Isolation: one network per tenant, egress rules as today (`computer-isolation.sh`) per host, no shared Docker socket with tenants. Revisit per-bot UIDs as the only boundary between bots of different tenants; require tenant-per-VM or tenant-per-host if the review says it is not enough.

### E. Operations (M)
- Backups: scheduled off-host dumps or WAL archiving, retention, a scheduled restore-verify, and tenant-key backups kept apart from the database (as the README already requires for the master key).
- Monitoring: per-tenant usage and error metrics on `/metrics`, health probes for API, worker, compute host and Postgres, alerts on `computer_isolation_missing` and spend spikes.
- Rate limiting: move the in-memory limiters (login, device pairing; they reset on restart) to a shared store, and add per-tenant and per-IP limits on signup, API and model calls.
- Abuse controls: a tenant suspend switch that stops tasks and computers, signup throttling, an admin view over the audit chain.
- Persist idempotency keys and delete tombstones (in API memory today, per the README) before running more than one API instance.

### F. Security and compliance (M)
- Threat model for hosted use: tenant escape from a computer, noisy neighbours, SSRF through plugins and the model gateway, prompt injection across tenants.
- PolicyGate, DLP, TEAMS-ISO and per-bot workspace privacy stay authoritative (`docs/SECURITY.md`). Hosted mode adds controls and relaxes none.
- Independent review of the RLS policies and the compute boundary before signup opens.
- Per-tenant data export and delete (including S3 artifacts and keys), retention settings, a sub-processor list, and terms/privacy drafts (these need legal review).
- Hosted mode must refuse to start with the seeded `saad` account or dev passwords. `REQUIRE_OWNER_PASSWORD=true` already refuses the dev owner password (`LoginBroker.cs`).

### G. Carry-over items
Checked in the repo. Four of these have schema or code from v0.3, so the first task for each is an audit of what is still missing.

| Item | What exists | What v0.5 does | Size |
|---|---|---|---|
| Lazy tool catalog | `search_tools` and `load_tool` meta-tools, a compact tool index with a 1800-character budget (`V03.cs`, `PluginCatalog.cs`) | Audit against Rakazo's idea (cap on directly exposed tools, `execute_tool`), measure with thousands of tools, fix gaps | S |
| Durable outbound log | `outbound_actions` table with a unique idempotency key and retry counter; a v0.4 security note says the ledger is used for plugin writes and purchases | Audit coverage of every send/post/purchase path, add review-decision fields, make tenant-scoped | S |
| Plugin health checks | `health_status`, `health_detail`, `health_checked_at` on `plugin_catalog`, a `health` job kind; unhealthy plugins are filtered from queries | Audit the scheduler, add backoff and per-server timeouts, show health in UI | S-M |
| Change-only routine wakes | `watch_kind`, `watch_ref`, `watch_fingerprint` on `routines`; a scheduler check in `Program.cs` that skips the model when `http` or `memory` content is unchanged | Add file/command/tool watchers with a minimum interval, test that no model call happens when nothing changed | M |
| Phone link via own tunnel | Not in the repo or docs; a goal from our conversation | Documented setup using the operator's own tunnel (needs their account, PC or VPS). Not a hosted feature | S-M |
| Installable PC companion app | `companion/` is a stdlib-only Python CLI at 0.4.0; pairing, heartbeat and permissions work, but `docs/COMPANION.md` says execution transport is not yet connected to the worker | Wire execution to the worker behind `DeviceGate`, then package a Windows/Mac installer with an OS credential store | L |

## 4. Milestone order

1. **M1 Decisions and design (S):** tenant model, email provider, spend-cap approach, content-encryption/search decision, compute host design. Output: short ADRs.
2. **M2 Tenant model + RLS (L):** tenant id, backfill, non-owner login, policies, cross-tenant tests, CI check. Nothing else ships before this.
3. **M3 Accounts (M-L):** email, verification, signup switch, orgs and members, password reset.
4. **M4 Plans, metering, spend caps (M-L):** entitlement check, usage ledger, caps. Payment provider hook last.
5. **M5 Keys and content encryption (L):** per-tenant keys, rotation, encrypted content columns, backup/restore updated.
6. **M6 Ops (M):** off-host backups, shared rate limiting, per-tenant metrics, suspend switch, persisted idempotency.
7. **M7 Remote compute (L):** provider contract additions, host service, conformance suite, quotas and scheduling. Can start in parallel with M3 once M1 is done.
8. **M8 Carry-overs (S-L):** G items; the first four can fill gaps between larger milestones.
9. **M9 Security review and closed beta (M):** external review, load and abuse tests, then invite-only signup.

## 5. Risks

- **RLS retrofit.** Many tables reach the owner through joins, and workers and the scheduler run outside a request. Mitigation: tenant-setting helper, test per table, CI guard.
- **Encryption versus search.** Full-text and vector search over encrypted content is hard. Mitigation: decide in M1 and document honestly.
- **Compute isolation.** Containers with per-bot UIDs may not be enough between unrelated paying tenants. Mitigation: threat model and review before signup; tenant-per-host as a fallback.
- **Model spend.** A runaway task can burn a tenant's budget. Mitigation: check the cap before every model call, keep the loop guards, alert on spikes.
- **Scope.** This is large for one release. Mitigation: milestones are ordered so M1-M6 deliver a closed beta on the existing Docker provider; remote compute can slip without blocking it.
- **External dependencies.** Email, payments and legal review depend on decisions and accounts outside the code.
- **Migration of existing data.** Backfilling orgs and encrypting existing rows must be reversible and tested on a restored backup.

## 6. Definition of done

v0.5 is done when all of the following are true on a staging stack:

1. The API and worker connect with a non-owner role that cannot bypass RLS. A test that drops the application's tenant filter still returns no other tenant's rows for every tenant table, and CI fails on a new table without a policy.
2. A new user can sign up, verify their email, create an org, and invite a member who joins with the invited role.
3. Each org has a plan with enforced limits. A task is refused with a clear message when the monthly spend cap is reached, and the usage page matches the recorded `model_calls`.
4. Message, transcript and memory content is encrypted under per-tenant keys, with rotation tested, or the plan states exactly which columns are not encrypted and why.
5. Computers can run through the `remote` provider and pass the same conformance suite as Fake and Docker, with per-tenant quotas enforced.
6. A scheduled off-host backup runs, a restore-verify has passed within the last week, and the suspend switch stops a tenant's tasks and computers.
7. Rate limits survive an API restart.
8. Each carry-over item in section G is closed or explicitly deferred with a reason in `CHANGELOG.md`.
9. All existing suites (`make test`) still pass, and PolicyGate, DLP and TEAMS-ISO behave as in v0.4.
