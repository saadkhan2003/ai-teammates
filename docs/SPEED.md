# Speed plan

## Phase 4 frontend loading and bundles

Every web and admin page route has a segment `loading.tsx` with fixed-size skeletons shaped for its page type. The bot route uses a chat skeleton; form and table routes reserve their main content area to keep navigation from shifting the page while client data arrives.

The sidebar prefetches `/api/bots/{id}/workspace` on link hover or keyboard focus and keeps the JSON in the small in-memory TTL cache at `apps/web/lib/prefetch-cache.ts` for 30 seconds (bounded to 64 entries). The bot view can read the same URL key through `get`; stale data is removed on access. Next route prefetch is enabled on the links as well.

The bot `Workspace` is a dynamic import. The global shell defers the plugins pane and the create-bot template/avatar controls, which are only needed after opening those dialogs. Both Next configs optimize named `lucide-react` imports. Source-graph estimates, pending Docker measurements: deferring the workspace may remove roughly 50–150 KiB gzip from a bot route's initial chunk set, and deferring shell dialog code may remove roughly 10–40 KiB from routes that do not open those dialogs. Icon import optimization is expected to save under 5 KiB per route. These are estimates, not measured savings. The likely largest remaining web first-load route is `/bots/[id]` because its route still uses the shared app shell and chat UI; settings routes also share that shell. Admin routes share `AdminShell`; `/ai-models` is the likely admin route to watch. The CI bundle job enforces 200 KiB gzip for each measured route in both apps and emits JSON reports.

React Compiler remains off. Next.js 15 supports `experimental.reactCompiler`, and its documented setup requires `babel-plugin-react-compiler`; the plugin is an optional Next peer dependency but is absent from the installed tree and lockfile package records. Enabling it would therefore require adding a package and lockfile update, so it does not meet this task's no-new-package condition. Next 16 is optional and not part of this change; an upgrade should update Next and React compatibility together, move `reactCompiler` to the stable top-level option if enabled, then run both app builds and the route budget before adoption.

The 200 KiB target has not been measured locally because host builds are prohibited. The orchestrator should review the CI route reports and split any route that exceeds the limit.

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
