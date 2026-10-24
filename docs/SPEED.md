# Speed plan

## Phase 0 measurement

Phase 0 adds measurements only. Chat sends, task execution and paint behavior stay as they were. Non-streaming provider TTFT equals the full provider response wall time; Phase 2 will supply the real first-token clock at the `Runtime.StoreModel` seam. `latency_ms` is retained. Provider usage includes read/write cache tokens when reported; absent usage stays NULL, not an invented hit.

Apply migration `043_speed_telemetry.sql` through the API image's normal migration startup. `perf_events` retains seven days; the recorder deletes older rows hourly. The singleton `PerfRecorder` uses a 4096-event queue, nonblocking `TryWrite`, and batches up to 512 rows every two seconds. Overflow and unavailable DB batches are dropped. `Dropped` exposes the process-local drop count. Samples are deliberately lossy and recent queued data can be lost on restart.

API JSON durations exclude SSE, VNC and RUM. Every routed JSON request updates a 256-value in-memory ring keyed by endpoint route template (`RouteSnapshot` gives local p50/p95); approximately one in ten is persisted. Unknown/unmatched routes and raw resource ids are not retained. SSE fan-out samples one in ten live deliveries, from monotonic event creation to successful write+flush. Replay/backfill is excluded; deliveries whose creation timestamp has left the 200-event SSE ring are omitted. The connection comment is retained and a cheap `event: ready` frame allows load tools to time the first event. The web stream parser ignores the named ready frame before calling application subscribers, avoiding extra workspace reloads. Its payload also has no application `type`.

Later compute stages can inject `PerfRecorder` and call:

```csharp
var clock = Stopwatch.GetTimestamp();
// perform stage
recorder.Record("wake_paused_ms", Stopwatch.GetElapsedTime(clock).TotalMilliseconds);
// Other planned names: warm_pool_ready_ms, computer_create_ms, computer_unpause_ms, computer_chrome_healthy_ms.
```

`Record(name, ms, attrs)` never performs DB IO on the caller. Use fixed metric names and content-free attributes, never prompts, filenames, provider output, credentials or raw routes. Measurements must not alter PolicyGate, DLP, isolation, per-bot privacy or audit logging.

### Browser and RUM

`apps/web/lib/perf.ts` marks sends and records post-commit paints with two animation frames. It records echo, first acknowledgement/activity, first reply text (full reply on the old UI), tool card and sidebar chat switch paints. Turn activity is correlated by task id. A local bounded `window.__teammatesPerf` array contains only `{name,value_ms,at}`. A navigation-template route and numeric/boolean diagnostics are batched to `/api/rum` every five seconds and on pagehide using keepalive/beacon. `web-vitals` supplies LCP and INP. The server also accepts CLS (unitless), but it is not a speed-dashboard target.

`POST /api/rum` requires a valid session, rejects cross-site origins, permits 12 batches per user per minute, limits the request to 32 KiB and 50 events, and accepts only `echo_ms`, `ack_ms`, `first_token_screen_ms`, `tool_chip_ms`, `chat_switch_ms`, `lcp_ms`, `inp_ms`, `cls`. Finite values clamp to 0–600000. Routes use an explicit template allowlist. Attributes cap at 1024 characters and eight keys; only numeric/boolean `cached`, `proxy`, `sample_rate`, `duration`, `count` survive. All string values, arbitrary keys and nested content are discarded. These best-effort samples never enter the task/audit path.

### Baseline browser benchmark

Run on an **isolated mock-provider stack** with an owner account with room for three disposable bots. The spec reuses login/bot helpers and configures a mock-only fixture key if absent; cleanup removes only its bots/key. It runs against the old UI too: page-side observers and animation-frame checks use existing composer, working-row, message and tool-card selectors. No new browser marks are needed to obtain the baseline.

```sh
STACK=your-isolated-stack BASE_URL=http://your-test-stack LLM_PROVIDER=mock PERF=1 PERF_LABEL=before \
  /workspace/ai-teammates-live/wt-logs/heavy.sh \
  tests/e2e/node_modules/.bin/playwright test -c tests/e2e/playwright.config.ts perf-speed --project=desktop
```

Do not use a paid-provider stack. Run the same command with `PERF_LABEL=after` on the changed build. `@perf` tests are excluded by default. Results go to `test-results/perf/{label}.json`, with ten samples each, interpolated median/p95, targets and optional `client_marks`. `PERF_ENFORCE=1` fails metrics above their p95 targets; without it, slow metrics are reported. Missing UI signals still fail the test. Cached switches visit both chats before timing; cold switches target a newly seeded, never-visited chat (HTTP/CDN/Next link prefetch caches are not disabled). Cold switch has no speed-plan target. LCP is observed after reload. `inp_proxy_ms` uses click EventTiming duration where emitted; sub-16ms/non-emitting synthetic clicks fall back to click-to-two-rAF time. It is an INP **proxy**, not full-page web-vitals INP. No streamed output is introduced by this work.

### Load and bundles

See [load instructions](../tests/load/README.md) for `xk6 build --with github.com/phymbert/xk6-sse` and the 50→200 VU SSE/JSON script. Credentials come from `K6_USER` / `K6_PASSWORD`, the target from `BASE_URL`; setup logs in once. The [extension API](https://github.com/phymbert/xk6-sse) supplies the SSE event callback. k6 requires the isolated stack and must run outside this Docker-free sandbox.

After the orchestrator builds the web image, run the reporter against its extracted `.next` directory:

```sh
node scripts/bundle-budget.mjs --next apps/web/.next --out test-results/bundle-budget.json
node scripts/bundle-budget.mjs --next apps/web/.next --enforce
node --test scripts/bundle-budget.test.mjs
```

It sums gzip bytes of unique first-load JS resources per route, including enclosing app layouts, page chunks, shared runtime and polyfills. Lazy chunks are excluded. Default is report-only; `--enforce` returns nonzero above 200 KiB gzip. No CI wiring is added in Phase 0. The API reports bundle size as missing/source `ci` until `first_load_js_kb` samples are supplied.

### Staff speed API

`GET /api/admin/speed?hours=24` uses the existing session + owner/admin role guard (members get 403). Hours clamp to 1–168. Response has `window_hours`, `generated_at` and `metrics` with `key`, `label`, `unit`, `p50`, `p95`, `count`, `target_p50`, `target_p95`, `source`. Missing data has null percentiles and zero count. SQL uses `percentile_cont` over persisted samples. Model TTFT/total use `model_calls`; cache-hit share is `100 * sum(cached_tokens) / sum(prompt_tokens)` for the window, with count of calls reporting cache usage. Its p50 field is the aggregate percentage, p95 is null, and its target is strictly >70% (label). Model-total and cold-switch latency have no plan targets. All target constants live in `SpeedTelemetry.Targets`. The endpoint is admin-only; model/provider details are never added to the user UI.

Local checks: web `tsc`, node helper/bundle tests, focused C# and mock-cache pytest tests. Full C#/Python suites require writable heavy-wrapper locks. Integration tests in `tests/integration/test_speed_telemetry.py` are syntax-checked here; run them, Playwright, k6 and actual bundle measurement through the orchestrator.

## Phase 3: computer wake, readiness and warm templates

The composer calls `POST /api/bots/{id}/computer/prewarm` on focus/input. A small shared hook suppresses further requests for that bot for 30 seconds, including across chat switches. The endpoint validates the session, same-origin request, bot owner (other owners get 403), user computer quota and the existing PolicyGate decision for `computer.prewarm` (write class). ASK and DENY both refuse this speculative work. It resolves the existing bot placement and returns 204 if no owned computer is already in inventory. Focus never creates or restores a missing computer, starts a task, executes a bot tool, or changes desktop control/leases.

Accepted requests return 202 before Docker work. A process-local 128-request queue runs at most two wakes concurrently; duplicate bot requests within 30 seconds or pending requests for the same shared computer get 429, as do more than 12 admitted requests per owner per minute. Queue saturation returns 503. Repeated focus cannot build an unbounded backlog. Limits reset on API restart. Background work rechecks owner, policy, quota and placement, writes `computer.prewarm` to the audit chain, then wakes the existing owner-bound computer through the normal isolation guard. A full host or unavailable desktop simply leaves the speculative request unsuccessful; normal task execution retains its own retry/recovery path.

Readiness probes run immediately, then after 50, 100, 200 and at most 250 ms. `COMPUTER_READINESS_TIMEOUT_SECONDS` controls the overall readiness deadline (default 45); it cancels stalled probes as well as delays. On the configured computer network, the API awaits the computer service's existing `/desktops` initialization response, then verifies `/json/version` has a CDP websocket endpoint. This gives a service-driven readiness response without waiting for Docker's periodic health status. Network-less contract clients use the bounded exec probe, which also checks CDP. Explicit starts and task/view wakes use the same readiness path. Concurrent wakes of one computer converge, and failed readiness invalidates the old ready marker.

`WARM_POOL_SIZE` defaults to **0** in production compose and **1** in `scripts/gen-stack-compose.py` (`--warm-pool-size` overrides it). Docker mounts and environment bindings cannot be changed on a running container, so this implementation uses the plan's safe **paused template** alternative. A template initializes the configured image's container/base layers with a sleeping process, then pauses. It has no owner/computer-id labels, credential environment, user mounts, desktop, browser or profile; its root filesystem is read-only. It uses the normal seccomp/no-new-privileges, resource budget, stack label and isolated computer network, and creation still requires the stack isolation guard. Its pool label is `teammates.warm_pool=template`.

A first allocation destroys one template **before** creating the real computer with the normal fresh workspace/profile volumes, quota mounts, identity and privacy controls. No template state or writable layer is transferred. Refills run in the background within two seconds (signaled after allocations); a single allocation gate prevents create/refill/resume from overbooking `MAX_COMPUTERS`. Paused computers and templates count against active capacity; stopped/hibernated computers release their active slot. A resume may evict a template to reclaim that slot. An owner quota is checked again before speculative resume. Released user computers never enter the pool. Shutdown reaps templates; startup reaps stale templates before filling, including when size/image/network configuration changes or size becomes zero. Templates are excluded from the restored computer inventory. Use one pool-maintenance API per stack: the generated secondary API has `WARM_POOL_SIZE=0` and `WARM_POOL_MAINTENANCE=false` so it cannot reap the primary API's templates. Multiple independent inventory writers still require shared daemon-level admission in a future compute host.

This template approach warms image/container layers, **not Chrome**. It pays the fresh mount and browser startup cost on claim, so the <5 s pool-ready target must be measured on the deployed image and host; it is not guaranteed by template availability.

All successful stages call the Phase 0 nonblocking `PerfRecorder.Record(name, ms, attrs)` through a compute callback, with only `{path: create|unpause|resume|pool}`. `computer_create_ms` measures creation/mount setup, `computer_unpause_ms` start/unpause, and `computer_chrome_healthy_ms` the wait for actual CDP readiness. `computer_ready_ms` is ordinary create/restore total; `wake_paused_ms` is wake total for either paused or stopped/hibernated containers; `warm_pool_ready_ms` includes template claim/destruction through fresh computer readiness. Failed readiness does not emit a success total. Existing `/api/admin/speed` aggregates both planned wake/pool metrics from `perf_events`; no schema/dashboard change is needed.

Local tests cover adaptive intervals/deadline/cancellation, prewarm authorization/policy/rate limits/background response/audit, real recorder persistence, pool capacity/refill/shutdown/never-reuse, template isolation, and Docker lifecycle stages using an in-memory Docker HTTP handler. `tests/integration/test_speed_compute.py` is syntax-checked here. The orchestrator must rebuild an isolated mock stack and run it with `pytest -q -s`: it prints five paused-wake samples with interpolated p50/p95 (requires p95 <2000 ms), pool claim readiness (<5000 ms), checks refill identities, and checks other-owner 403. Its five wake cycles honor the public 30-second limit, so allow more than two minutes. It never modifies firewall rules. Real stack timings, Docker-backed contracts, integration, chaos and Playwright remain orchestrator checks; no target measurements are claimed from mocks.
