# Architecture G1 report

Moved VNC and terminal tickets, Teach exclusivity, login credential slots and rate windows into Postgres. Tickets are SHA-256 hashed, single-use, DB-expiring and claim-bound; VNC session tokens and submitted login fields are AES-GCM encrypted under the shared API master key. RW VNC heartbeats and release grace use database rows and a `SKIP LOCKED` sweeper. Relay sockets remain instance-local with Caddy affinity and clear mismatch closes.

Files: `db/022_tickets_state.sql`; `apps/api/{DesktopLeases,DesktopRwConnections,Devices,Dockerfile,EgressControlRoutes,EgressRelay,LoginBroker,LoginFlow,OneTimeTickets,Platform,Program,Routes,Teach,TerminalTickets,VncTickets}`; `deploy/Caddyfile.{production,test}`; `docs/SECURITY.md`; ticket/lease tests and `tests/integration/test_two_api_instances.py`; this report.

Validation: C# 239 passed with PostgreSQL tests enabled; Python 207 passed, 1 skipped; two-API WebSocket smoke test skipped because `API_URL_A`/`API_URL_B` were unset; `git diff --check` passed. No git write was attempted.

Security: raw tickets are never stored, failed claim checks do not consume rows, DB time controls ticket expiry, and credential-bearing scopes are encrypted and not logged. Remaining limitation: SSE event rings/channels are instance-local transient delivery; shared cross-instance fanout is still needed for reliable live updates.

## Process-local state inventory and decisions

| State | Location | Decision |
|---|---|---|
| VNC ticket entries and per-process IP key | `VncTickets.cs` | Removed. Hashes and encrypted scope now live in `one_time_tickets`; IP binding uses HMAC with the shared master key. |
| RW VNC connection counts and close timers | `VncTickets.cs`, `Routes.cs` | Removed from correctness path. `desktop_rw_connections`, `release_after`, DB time and the all-instance sweeper coordinate release. |
| Terminal ticket acceptance | `TerminalTickets.cs` | Added API-side Postgres consume; computer-side HMAC and local single-use set remain defense in depth. |
| Teach active session | `Teach.cs` | Unique `active_teach` row with 10-minute expiry; stop claims the row once. |
| Egress decision rate window | `EgressControlRoutes.cs` | Atomic Postgres upsert, DB clock. |
| Login attempt/failure and device pairing rate limits | `Platform.cs`, `Devices.cs` | Postgres event/counter rows with hashed IP scopes and DB time. |
| `LoginRateLimiter` in-memory helper | `LoginRateLimiter.cs` | Retained only for pure unit tests; production login and device pairing paths now use Postgres. |
| Submitted login form fields | `LoginBroker.cs`, `LoginFlow.cs` | Encrypted Postgres slot with shared master key, five-minute DB TTL, atomic delete on take. |
| Live egress relay socket pairs | `EgressRelay.cs` | Remain in memory because sockets cannot move. Both ends need the same API instance; Caddy hashes `X-Relay-Affinity` when clients provide the same value. Duplicate role connections fail closed with a clear WebSocket policy close. |
| Mock OAuth code dictionary | `V03.cs` | Remains process-local; dev-only mock path, as requested. |
| Bot UID cache | `BotFs.cs` | Remains a re-derivable performance cache; another instance asks the shared computer to ensure the UID. |
| Task wake signal | `TaskSignal.cs`, `Platform.cs` | Remains local notification only; task state and leases are Postgres-backed and workers poll. |
| SSE ring and subscriber channels | `SseLog.cs`, `Platform.cs`, `Routes.cs` | Remain per-instance transient delivery buffers; not authoritative task/session state. A reconnect can miss events published by another instance, so cross-instance SSE fanout still needs a shared event transport. |
| Metrics counters and `BootId` | `Platform.cs` | Per-instance by design; metrics are local and boot IDs distinguish instances. |
| `IdempotencyStore` field | `Platform.cs` | Unused field; no active API behavior depends on it. |
| Static immutable dictionaries | `Policy.cs`, `ToolSchema.cs`, other schema helpers | Configuration/constants, not mutable runtime state. |

Security: no raw ticket is stored. Ticket consume binds user, bot, and IP in the atomic update; wrong claims do not burn a row. DB time controls expiry. Credential-bearing scopes are encrypted and never logged. No git write was attempted.
