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
// Other planned names: warm_pool_ready_ms, compute_create_ms, compute_unpause_ms, chrome_healthy_ms.
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

## Phase 1 quick wins

The composer commits a pending message in the submit frame, using a random `client_id` as the message UUID and retaining it in message metadata. The API inserts the message and task in one transaction; retrying the same id returns the existing task. Failed sends retain their content with a Retry action. No schema migration is needed. Workspaces use a ten-entry per-tab LRU and show cached content while revalidating. Task acceptance publishes `task.started` before waking the worker, displaying “On it” without a model call.

Session user lookups cache positive results for at most 45 seconds and never beyond session expiry, with a 4096-entry bound. Logout deletes the server session; role/status changes and session revocation invalidate cached lookups with generation fencing. Password-reset code must invalidate the affected user as well. Stable system, skill catalog and memory blocks precede history; live state is appended in an ephemeral last user block. Native caching anchors tools, system and memory when enabled. Conversation ids remain stable cache/session keys. Latency routing is optional `provider.preferred_max_latency`, in seconds. Public and admin Caddy listeners compress normal responses with zstd/gzip, explicitly excluding SSE and VNC.

Phase 1 browser checks live in `speed-phase1.spec.ts`; run on an isolated mock stack through the orchestrator.

## Phase 2 streaming and event patches

The Python worker requests `stream:true` from `/internal/model/complete`. The API owns the upstream stream and publishes owner-scoped deltas directly to the browser; Python receives the final assembled completion over the existing response, avoiding another token relay hop. Complete-response callers, including compaction, remain supported. The additive adapter is `AiStreamingGateway` in `ModelStream.cs`. It uses the resolved primary/fallback endpoints, conversation session key and optional role token cap. The parsers accept arbitrary TCP/UTF-8/JSON splits, compatible `data:` frames, and native message/content-block/input-JSON/usage events. Compatible requests include final usage. Real TTFT starts at the provider request and stops on the first content or tool-call delta; total time and read/write cache usage use the existing `model_calls` columns. Streams with no content/tool delta retain NULL TTFT. No migration is required.

Transient HTTP/connect failures can try a fallback before any response body bytes. Once any bytes arrive, malformed/truncated/error streams fail the call and clear the draft; they never silently switch endpoints. Cancellation and lease changes stop publication. Runtime authenticated requests disable redirects. Peer-task and routine responses use the streaming parser without publishing draft content, preserving their quiet completion rules.

DLP sees complete sentences before publication. Identifiers and credentials split across chunks remain buffered; private-key blocks remain buffered through completion. The same redactor processes the assembled final response. This deliberately delays first paint until a safe sentence boundary, and a short single sentence may appear only at completion. Tool arguments are assembled by index for the worker but never streamed to browsers; chips receive only tool names validated against that request's tool catalog. The browser maps those names to neutral labels.

One module-level fetch stream serves all subscribers in a tab, preserving `Last-Event-ID`, visibility reconnect and connection status. A leaf draft component owns token renders and batches updates with animation frames; token arrival never updates the history list. A completed message replaces its task draft, with markdown rendered in both states. Event projections carry small task/bot/message/approval patches, scrubbed by DLP and scoped to the owner on both live delivery and replay. Notifications have a separate small patch. Unknown events and explicit replay gaps revalidate; normal messages/tasks update state directly. The 15-second workspace/roster poll runs only while the stream is disconnected. Logout clears per-tab cached workspace data. Session invalidations also propagate through PostgreSQL notifications, with the 45-second TTL covering missed notifications.

Read-only batches use an explicit allowlist in `services/agent/parallel_reads.py` and `asyncio.gather`. Each call still passes budget/scoped-rule preflight and the existing authorization/PolicyGate/DLP path. Tool results stay in original call order even when execution finishes out of order; exceptions wait for siblings before propagating. Unknown/plugin tools, browser/desktop interactions, writes and mixed batches remain sequential. Task-step sequence allocation and checkpoint updates share a row-locked transaction, preserving the audit step ledger under concurrent reads.

The mock supports streaming on `/api/v1`, `/p2/v1` and `/anthropic/v1`. `MOCK_STREAM_DELAY_MS` defaults to 20; `MOCK_FIRST_TOKEN_DELAY_MS` (also `MOCK_STREAM_FIRST_TOKEN_DELAY_MS`) controls initial delay. `SPEED STREAM DEMO` provides multiple sentences and `SPEED TOOL DEMO` exercises the tool chip. Both browser specs require explicit `LLM_PROVIDER=mock` and are included in the desktop project:

```sh
STACK=your-isolated-stack BASE_URL=http://your-test-stack LLM_PROVIDER=mock \
  /workspace/ai-teammates-live/wt-logs/heavy.sh \
  tests/e2e/node_modules/.bin/playwright test -c tests/e2e/playwright.config.ts 'speed-phase[12]' --project=desktop
```

The Phase 0 integration assertion now accepts measured `ttft_ms <= total_ms`; the new streaming contract requires a strictly earlier first delta for the delayed mock fixture. Integration and Playwright execution, Caddy adaptation, image rebuilds and bundle-budget measurement require the orchestrator's isolated stack.
