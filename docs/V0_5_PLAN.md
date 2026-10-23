# v0.5 plan: SaaS foundation (optimized)

Status: proposal, final choices are Saad's. No dates are promised. Effort: **S** = days, **M** = 1-2 weeks, **L** = more than 2 weeks.
**Estimate** marks any number that is a planning assumption and not measured or published. Re-check every estimate against current provider pricing before using it for prices.

Sources read for this revision: `README.md`, `docs/V0_4.md`, `docs/SECURITY.md`, `docs/COMPANION.md`, `db/001`-`014`, `apps/api`, `src/Compute.*`, `deploy/`, `scripts/backup.sh`, and `/workspace/research/RAKAZO_STUDY.md` (ideas only; Rakazo is Apache-2.0, credit it if code is ported). The README says "SaaS later" but gives no plan, so this theme is a proposal.

## 1. Goal and principles

Take v0.4 from "self-hosted, one trusted operator" to "a hosted service where unrelated customers share infrastructure safely and the operator does not lose money": the database enforces tenant isolation, signup is safe to open, every tenant has plan limits and a server-enforced spend cap, idle tenants cost almost nothing, and operators can back up, monitor, suspend and delete a tenant.

Principles: ship a closed beta on today's Docker provider first (M1-M6); weaken none of PolicyGate, DLP, TEAMS-ISO or per-bot workspace privacy; never claim "everything is encrypted" until it is true. Non-goals: mobile apps, voice, messaging channels, final prices.

## 2. Starting point (verified in the repo)

- **Tenancy is user-level, enforced in API code.** `bots.owner_id` references `users` (001); `user_quotas`, `user_computers`, `devices` are keyed by user; `messages`, `memories`, `artifacts` reach the owner only through joins via `bots`/`conversations`; `model_calls` and `outbound_actions` carry a nullable owner id.
- **No RLS, no organization.** `db/*.sql` has no `ROW LEVEL SECURITY` statements and no org table. Roles are `owner`/`admin`/`member` per user (003). The API connects as `POSTGRES_USER` (default `agent`), which owns the schema.
- **No email on users, no signup route.** `users` has `username` and `password_hash`; `email` exists only on `invitations`; the README says email verification is not in this build.
- **Encryption covers secrets only** (AES-256-GCM, one master key in a Docker secret file). `messages.content`, `task_transcript.content`, `memories.content` are plain `text`.
- **Only memories are searched in SQL:** `memories_fts` (GIN on `to_tsvector`) and `ts_rank` then `embedding <=> @emb` (`vector(64)`) in `Runtime.cs`. Messages and transcripts are not.
- **Quotas exist, caps do not.** `user_quotas` defaults: 8 bots, 1 computer, 1.5 GiB RAM, 1000 millicores, 10 GiB disk, 6 parallel tasks, 40 secrets. `model_calls.cost_usd` is recorded and `GET /api/usage` sums it. No plan table, no spend cap. `ProviderWire.cs` can read the OpenRouter key's `limit_remaining`.
- **Compute.** `IComputeProvider` covers lifecycle, exec, desktop, snapshot/restore, capacity and health. Only `DockerComputeProvider` exists (`remote` is reserved; `compute.proto` is linted, not served). Containers get memory and CPU limits (swap equal to memory), a custom seccomp profile, `apparmor=unconfined`, 64 MiB shm and `/tmp`, and the default runc runtime. Isolation is `deploy/computer-isolation.sh` (TEAMS-ISO) plus per-bot UIDs.
- **Idle hibernation exists.** `IDLE_POWER=hibernate` stops an idle computer after 10 min (`IDLE_SUSPEND_MINUTES`); `reclaim` pauses, then hibernates after 30 min; `IDLE_RESUME_TARGET_SECONDS` is 15. `HostBudget` allows 2 computers on a 4 GB host, 3 on 6 GiB or more.
- **Queue is Postgres:** workers lease with `FOR UPDATE ... SKIP LOCKED` (`Routes.cs`, `tasks_lease_idx`).
- **Ops.** `backup.sh` and `restore-verify.sh` exist; `/metrics` is token-gated; login and device-pairing limiters, idempotency keys and delete tombstones live in API memory and reset on restart.

## 3. Architecture decisions (recommended)

### 3.1 Tenant isolation in Postgres: shared schema + RLS (recommended)

| Option | Pros | Cons |
|---|---|---|
| **Shared schema, `org_id`, RLS** (recommend) | Keeps `db/*.sql` as is, cheap per tenant, easy admin reports, works with pgvector and the lease queue | A missing policy is a leak (needs a CI guard); noisy neighbours on shared indexes |
| Schema per tenant | Strong logical split, easy per-tenant dump | Migrations run N times, catalog bloat past a few thousand tenants, global jobs span schemas |
| Database per tenant | Strongest split | Heavy to operate; only for enterprise later |

How: add `org_id` to every content table (backfill each user as a one-user org); create `teammates_app` (no `BYPASSRLS`, not the table owner) for API and worker and keep the owner role for migrations; `FORCE ROW LEVEL SECURITY`; `SET LOCAL app.org_id` per request and job. The task leaser and scheduler use a narrow system role that reads only lease columns, then run the task as its org. CI fails if a table lacks `org_id` and a policy (allow-list for global tables such as `plans`). Index hot tables (`messages`, `tasks`, `model_calls`) with `org_id` first.

### 3.2 Encryption versus memory search (recommended: two tiers)

Only `memories` is searched in SQL, so messages, transcripts and artifacts can be encrypted with no feature loss.

- **Tier 1 (v0.5, M5):** encrypt `messages.content`, `task_transcript.content` and artifacts with a per-org data key wrapped by the master key (associated data `{orgId}|{table}|{keyVersion}`, as the secrets design does). Rotate via a key-version column and a background re-wrap job.
- **Memories stay searchable:** protected by RLS, encrypted volumes and encrypted backups. `SECURITY.md` must say "memory text is not application-encrypted".
- **Tier 2 (later, "private memory"):** encrypt memories per org and rank by decrypting in the API (cap about 5,000 memories per search; encrypt or drop embeddings, since they leak meaning). Benchmark first.

Pros: protects dumps, backups and replicas for most data at low cost. Cons: a compromised API still holds the keys, and memory text stays readable to anyone with DB access. Client-held-key (zero-knowledge) is a non-goal.

### 3.3 Compute isolation tiers (recommended: hardened runc now, gVisor for paying tenants, Firecracker later)

| Tier | Runtime | Use | Notes |
|---|---|---|---|
| T0 (today) | runc, seccomp, per-bot UID, TEAMS-ISO | Owner-run host, invited friends | Shared kernel and `apparmor=unconfined`: not enough alone for unrelated paying customers |
| **T1 (beta)** | runc hardened: drop capabilities, `no-new-privileges`, `pids_limit`, read-only root where Chromium allows, user-namespace remap, one network per tenant | Vetted closed-beta users | Cheap; provider and compose changes only |
| **T2 (gate for paid signup)** | **gVisor (`runsc`)** Docker runtime | Paying tenants | Far smaller kernel attack surface; slower syscalls, possible Chromium/Xvfb/VNC breakage, so **spike first** (M7 week 1) with the desktop-speed and e2e suites |
| T3 (later) | **Firecracker/Kata** microVM per tenant | Enterprise, or if the gVisor spike fails | Hardware isolation; needs bare metal or nested virt and a new provider |

Keep the tier as a per-plan field (`compute_tier`) so a customer can move up without a redesign.

### 3.4 Idle hibernation and resume (extend what exists)

Already built: stop after 10 min idle, 15 s resume target. For a hosted fleet:
- Hibernate every tenant by default and track `resume_seconds` p50/p95; alert if p95 exceeds the target. Add a warm pool of 1-2 prebuilt containers per host if it does.
- **Remote hibernation:** after about 24 h idle, export `/workspace` and the profile to object storage and free the host disk; restore on any host on demand (needs the export/import contract in D). Until then the loop-disk file stays on the host and still costs disk.
- Meter running computer-hours and disk-GB-months separately; keep the `COMPUTER_MAX_TABS` cap (default 8).

## 4. Cost model (all figures are estimates unless marked measured)

### 4.1 What was measured
Local runs outside the repo (`/workspace/ai-teammates-live/`, not committed; the portal pages are test fixtures, so real web tasks will use more tokens):
- The 9-task eval run in `eval_results.json` (recorded against the mock/shim planner, not a paid model) used 1-5 model calls per task, about 2.6 on average. Real models may differ.
- `openai/gpt-4.1-mini`: about 1,100 prompt and 32 completion tokens per call, about $0.00046 per call, median latency about 1.05 s (measured, 22 calls).
- Flash-class models in the comparison runs (DeepSeek, GLM, MiMo): about 1,900-2,900 prompt tokens and $0.0001-0.0002 per call, median latency 0.7-3.4 s (measured, 30-48 calls each, single runs).

### 4.2 LLM cost per task and per tenant (estimate)
Planning range: 3-10 calls per real task and 2-3x larger prompts than the fixtures, so **about $0.002-0.015 per task on a mini-class model and about $0.0005-0.004 on a flash-class model** (estimate). A tenant doing 20 tasks per day (600 per month) costs roughly **$1-9 per month on mini-class and $0.3-2.5 on flash-class** (estimate). A heavy tenant (200 tasks per day) is about 10x that, which is why caps matter.

### 4.3 Hosted compute per tenant (estimate)
Assume one 8 GB / 4 vCPU host at about $40-80 per month (check provider pricing) running the stack plus about 3 concurrent computers (the `HostBudget` default for 6 GiB or more) at 1.5 GiB and 1 vCPU each. A slot costs about $15-25 per month if busy all day. A typical tenant is active 1-3 h per day (5-12 percent duty), so with hibernation and 4-6x overcommit compute is **about $2-6 per tenant per month**, plus disk (10 GiB, about $1) and object storage/egress (under $1): **about $3-8 per tenant per month before LLM cost** (estimate). A tenant that never hibernates (long routine, open desktop) costs the full slot, so routines count as running hours.

### 4.4 Plan limits (named limits and suggested starting values; no prices)
Suggested values are estimates chosen so that worst-case use stays below a price the operator picks later.

| Limit | Trial | Pro | Team |
|---|---|---|---|
| Bots / computers | 2 / 1 | 8 / 1 | 25 / 5 |
| Parallel tasks | 1 | 3 | 8 |
| Monthly model spend (cap) | $2 | $15 | $60 per org |
| Computer hours (running) per month | 20 | 100 | 500 |
| Disk per computer | 5 GiB | 10 GiB | 20 GiB |
| Compute tier / trial | T1, 14 days, no card | T2 | T2 |

Rule: price at least about 3x the estimated worst-case infrastructure cost for the plan, so a single heavy tenant cannot flip it to a loss.

### 4.5 Spend caps: own key vs platform key (recommended: BYO key first, platform key later)

| | Own OpenRouter key (BYO) | Platform key + per-tenant limit |
|---|---|---|
| Fit with today's design | Yes: `secret://openrouter/default` per owner | Needs a key issuer and ledger |
| Who pays the LLM | Customer, directly | Operator fronts it, recovers via plan or prepaid credit |
| Risk | No float risk, no LLM margin | Margin possible; unpaid usage, fraud, chargebacks |
| Cap enforcement | Server checks recorded `cost_usd` before each call; the key's own limit is a second guard | Same check plus a hard limit on the issued key (verify provider support) |
| Friction / abuse | High friction (customer needs a key); low abuse | Zero friction; trials can burn real money |

Recommendation: **BYO key for the closed beta** (least machinery, no float). Add **prepaid platform-key credit** once payments and the fraud controls in section 7 are proven. In both modes the API is authoritative: estimate the next call's cost, refuse or queue the task with a clear message if it could pass the cap, alert at 80 percent.

## 5. Workstreams

### A. Multi-tenant isolation (L, first)
Implement 3.1 and encryption tier 1 (3.2). Tests in `tests/integration`: per table, a query with the tenant filter removed returns no foreign rows; a task runs under its own org; CI fails on a new table without a policy; key rotation works on data written before and after.

### B. Accounts, signup, organizations (M-L)
- `email` (unique, normalized) on users; verification token single-use, hashed, 24 h expiry, rate limited (device-pairing pattern).
- Signup with an operator switch (`closed`, `invite-only`, `allowlist`, `open`); password reset; session list and revoke; `REQUIRE_OWNER_PASSWORD=true` in hosted mode.
- `organizations` and `memberships` mapped from `owner`/`admin`/`member`; invitations attach to an org. Decide how the one-computer-per-user rule (003) becomes per-org and what happens to existing bots.
- Email through the 8.3 provider with bounce/complaint suppression.

### C. Billing and metering (M-L)
- `plans` and `entitlements` (limits from 4.4), one `Entitlements.Check()` call site for every limited action.
- Append-only, idempotent usage ledger from `model_calls`, task counts and computer-hours; the usage page must match `model_calls`.
- Spend caps per 4.5. Payment provider behind a small interface: plan id on org, idempotent webhook table, dunning states, cancellation and a retention window after cancel.

### D. Hosted compute (L)
- `COMPUTE_PROVIDER=remote` from `compute.proto` on a separate compute host, so the API no longer needs the Docker socket proxy for computers.
- Workspace export/import in the contract (Rakazo idea #11) for remote hibernation; one conformance suite for Fake, Docker and Remote.
- Host-enforced quotas, a scheduler using `GetCapacityAsync`, per-tenant networks, isolation tier per plan (3.3).

### E. Operations (M)
- Off-host backups (dump or WAL), retention, scheduled restore-verify, tenant keys backed up apart from the database.
- `/metrics`: per-tenant usage and errors, queue depth, resume time; alerts on `computer_isolation_missing`, spend spikes and a failed restore-verify.
- Shared-store rate limits and persisted idempotency keys/tombstones before running more than one API instance.
- Suspend switch (stops tasks and computers) and an admin view over the audit chain.

### F. Security and compliance (M)
Abuse controls are in section 7. Also: hosted threat model (container escape, noisy neighbours, SSRF via plugins and the model gateway, cross-tenant prompt injection); external review of RLS and the compute boundary before signup opens; per-tenant export and delete (rows, S3 artifacts, keys); retention settings; sub-processor list; terms and privacy drafts (need legal review).

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

## 6. Performance and scale targets

Targets are proposals; each is measured in M9 on a staging stack and recorded in `CHANGELOG.md`. Baseline numbers do not exist yet, so M1 includes a baseline run.

| Area | Target (proposal) | How measured |
|---|---|---|
| API read endpoints | p95 under 300 ms at 50 concurrent users | k6 against staging |
| Task start | enqueue to first model call p95 under 3 s with a warm computer | task run events |
| Resume from hibernation | p50 under 10 s, p95 under 15 s (existing `IDLE_RESUME_TARGET_SECONDS`) | resume metric |
| Task queue | lease latency p95 under 1 s at 100 queued tasks; no task lost on API restart | integration test |
| Capacity | 200 tenants with 10 percent concurrent activity on a defined host fleet (size from the baseline) | load test |
| RLS overhead | under 10 percent p95 regression versus pre-RLS baseline | before/after run |
| Backup | restore-verify of a staging dump under 30 min; RPO 24 h (WAL archiving can bring this to minutes) | scheduled job |

- **Caching:** plan entitlements per org for 60 s (invalidate on plan change); tool-catalog index per tenant; never share cached message or memory content across tenants. PgBouncer in transaction mode works because the design uses `SET LOCAL`.
- **Queueing:** keep the Postgres `SKIP LOCKED` queue; add per-org concurrency from the plan, round-robin leasing by org so one tenant cannot starve others, and a "waiting for capacity" state for resumes.
- **Load tests:** k6 or Locust in `tests/load/`: mock model for throughput, a small real-model run for latency, and a 24 h soak at 20 concurrent tenants watching memory and open connections.

## 7. Security, compliance and signup abuse prevention

| Threat | Controls (server-side) |
|---|---|
| Bot signups, credential stuffing | Per-IP and per-email limits (for example 5 signups per hour per IP; estimate), CAPTCHA (Turnstile-class) on signup and reset, breached-password check, shared-store limiter that survives restarts |
| Fake or throwaway emails | Verification before any bot or computer exists; disposable-domain blocklist; one trial per verified email and per payment fingerprint |
| Trial compute abuse (mining, scanning, spam) | Trial on T1, TEAMS-ISO allow-list egress, CPU/egress caps, running-hour limit, auto-suspend on sustained 100 percent CPU |
| Card fraud, chargebacks | Merchant of record or provider fraud tools; no card-less platform-key usage until a paid period has passed |
| Spend runaway | Cap before every call, 80 percent alert, v0.4 loop guards, per-task call ceiling |
| Tenant escape | RLS, per-tenant networks, isolation tiers (3.3); no Docker socket reachable from computers (already true) |
| Abuse reports | Suspend switch, audit-chain admin view, tenant export/delete |

Before strangers sign up: lawyer-reviewed terms, privacy policy and sub-processor list; deletion within a stated window; a breach-notification runbook. SOC 2/ISO 27001 is out of scope; the audit chain and backups are groundwork.

## 8. The four open decisions: recommended answers (final choice is Saad's)

| Decision | Recommend | Pros | Cons / alternative |
|---|---|---|---|
| 1. Encryption vs memory search | Encrypt messages, transcripts, artifacts per tenant now; keep memory text searchable under RLS + volume encryption and say so; encrypted "private memory" later (3.2) | No search regression; covers most data cheaply | Memory text is readable by anyone with DB access, and the API holds keys. Alternative: encrypt memories now, rank in the API (stronger claim, slower, size-capped) |
| 2. Own key vs platform key | BYO OpenRouter key for the closed beta; prepaid platform-key credit later (4.5) | No LLM float risk, small build | Onboarding friction, no LLM margin. Alternative: platform key from day one (needs credit, fraud and chargeback handling first) |
| 3a. Email | Transactional API provider such as Postmark or Resend; SES if volume makes it cheaper | Fast to build, bounce webhooks | Per-email cost or monthly minimum (pricing unverified; check) |
| 3b. Payments | Merchant of record: Paddle or Lemon Squeezy. A web search on 2026-10-23 found Stripe does not list Pakistan as a supported country for taking payments, while Paddle and Lemon Squeezy support Pakistani sellers, handle tax and pay out by wire/Payoneer or bank/PayPal | Works without a foreign entity; tax handled | About 5 percent + $0.50 per sale (secondary source, verify), less control. If Saad forms a US/UK/UAE entity, Stripe becomes possible; the provider interface (workstream C) keeps the switch small. Confirm entity and bank first |
| 4. Container isolation | runc alone is not enough for unrelated paying tenants: beta on hardened T1 with vetted users, gVisor (T2) as the gate for paid signup, Firecracker/Kata (T3) if the spike fails or for enterprise (3.3) | Risk matched to cost, keeps Docker tooling | gVisor may break Chromium/VNC and slows syscalls; T3 needs a new provider and suitable hosts. Fallback: tenant-per-host for high-risk tenants |

## 9. Milestones, dependencies and acceptance tests

Each milestone ends with its acceptance tests green and `make test` passing.

| # | Milestone (size) | Depends on | Acceptance tests | Ships alone? |
|---|---|---|---|---|
| M1 | Decisions, baseline, ADRs (S): the four choices, tenant model, baseline load/cost run, gVisor spike plan | none | ADRs merged; baseline recorded in section 6 | Docs |
| M2 | Tenant model + RLS (L) | M1 | Per-table cross-tenant test; leaser-as-org test; CI guard; RLS overhead under 10 percent | Yes, behind a flag on staging |
| M3 | Accounts and orgs (M-L) | M2 | Sign up, verify, org, invite, join with role; reset; switch modes; abuse limits | Yes, closed/allowlist |
| M4 | Plans, metering, spend caps (M-L) | M2, M3 | Task refused at cap with a clear message; usage equals `model_calls`; one entitlement call site | Yes, without payments |
| M5 | Per-tenant keys + content encryption (L) | M2 | Columns unreadable in a raw dump; rotation test; restore verified on encrypted data | Yes, online backfill |
| M6 | Operations (M) | M2 | Scheduled off-host backup and restore-verify; limiter and idempotency survive restart; suspend switch works | Yes |
| M7 | Hosted compute and isolation tiers (L) | M1, M2 (parallel with M3-M6) | Remote provider passes conformance suite; host quotas enforced; gVisor spike passes e2e and desktop-speed, else T3 | Yes, T1 first |
| M8 | Carry-overs (S-L) | none (fill gaps) | Each item closed or deferred in `CHANGELOG.md` | Yes |
| M9 | Review, load, closed beta (M) | M2-M7 | External review closed; section 6 targets; 24 h soak; section 7 abuse tests | Invite-only beta |
| M10 | Payments, open signup (M) | M4, M9, T2 | Webhooks idempotent in test mode; dunning and cancel; legal docs live | Last; may slip to v0.5.1 |

Critical path: M1, M2, then M3/M4/M5 in parallel, M6, M9. M7 and M10 can slip without blocking the closed beta.

## 10. Risk register

| # | Risk (likelihood / impact) | Mitigation |
|---|---|---|
| R1 | RLS retrofit misses a table or a background job runs without a tenant (M / High) | `SET LOCAL` helper, per-table tests, CI guard, narrow system role |
| R2 | RLS slows queries (M / M) | `org_id` composite indexes, before/after baseline |
| R3 | Encryption claim overstated (M / High) | Precise wording in `SECURITY.md` (3.2); no claim until verified |
| R4 | gVisor breaks Chromium/VNC (M / M) | Week-1 spike; T3 or T1-only beta as fallback |
| R5 | LLM spend runaway or abuse (M / High) | Cap before each call, per-task call ceiling, trial limits, alerts |
| R6 | Free-trial abuse: mining, spam, scanning (H / M) | Section 7 controls, auto-suspend, no card trial |
| R7 | Cost estimates wrong (H / M) | Labelled estimates; measure in M9; fix limits before prices |
| R8 | Provider constraints: country, accounts (H / M) | Decide in M1; provider interface; merchant of record |
| R9 | Backfill corrupts existing data (L / High) | Reversible migrations, rehearse on a restored backup |
| R10 | Scope too large (H / M) | M1-M6 ship a beta; M7 and M10 can slip |
| R11 | Single Postgres/host failure (M / M) | Off-host backups and tested restore (M6); HA later |
| R12 | Legal gaps (M / High) | Legal review before open signup |

## 11. Definition of done

On a staging stack:

1. The API and worker use a non-owner role that cannot bypass RLS; dropping the tenant filter returns no foreign rows for every table; CI fails on a policy-less table.
2. Sign up, verify email, create an org, invite a member who joins with the invited role; abuse limits pass their tests.
3. Plan limits are enforced; a task is refused with a clear message at the spend cap; the usage page matches `model_calls`.
4. Messages, transcripts and artifacts are encrypted per tenant with rotation tested; `SECURITY.md` states that memory text is searchable and not application-encrypted (or tier 2 shipped).
5. Computers run through the `remote` provider (or Docker T1/T2 if remote slips, reason recorded) and pass the conformance suite with quotas enforced.
6. Off-host backup runs, a restore-verify passed within 7 days, and the suspend switch stops a tenant's tasks and computers.
7. Rate limits and idempotency keys survive an API restart.
8. Section 6 targets are met or each miss is recorded with a plan; each section 5G item is closed or deferred in `CHANGELOG.md`.
9. `make test` passes; PolicyGate, DLP and TEAMS-ISO behave as in v0.4.
