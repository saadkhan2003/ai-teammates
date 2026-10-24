# AI routing and production controls

The owner and admins use the separate admin site, **AI models**. Members get 403 on every `/api/admin/ai/*` endpoint. Routing, model/provider identifiers, pricing, keys and diagnostic details are admin-only. The user app shows neutral connection, pause and spending messages. Workers remain Python and call the ASP.NET API; credentials never go to workers or desktops. There is no external gateway or eval service.

## Deploy and bootstrap

Rebuild the API, admin and Caddy through your deployment procedure. Migrations 044 and 045 run automatically. Keep the admin listener bound to loopback (`ADMIN_PORT`, default 18082), use an SSH tunnel or trusted TLS proxy, and optionally restrict `ADMIN_ALLOWLIST`. Isolated stack generation accepts `--admin UNUSED_PORT`; it does not change the live stack's ports. Do not expose internal worker routes publicly.

With no active saved version, routing is version 0, using `LLM_PROVIDER`, `OPENROUTER_BASE_URL`, `MODEL_PLANNER` and the existing encrypted per-owner connection secret. Existing mock and production deployments keep working without admin setup. A missing legacy key produces a neutral wait. Bootstrap version 0 cannot be a rollback target: save and publish an explicit baseline first. Database versions are never updated or deleted; a database trigger enforces immutability. The active/candidate pointers, percentage and emergency controls live separately.

## Switch models in production

1. In **Providers & keys**, add a named provider, full API base URL and manual model entries. Supported kinds are OpenRouter, native Anthropic, OpenAI, Google’s compatible endpoint, another OpenAI-compatible endpoint and mock. Base URLs cannot contain credentials, query strings or fragments. Redirects are disabled on authenticated requests.
2. Save the write-only key and select **Test**. Tests use `/key` for OpenRouter and `/models` for compatible providers (native `/v1/models` for Anthropic), with a ten-second timeout. Results contain a sanitized status and latency, never raw errors or credentials.
3. In **Catalog**, select **Sync now**. Enabled providers are also synchronized nightly at 02:00 UTC. OpenRouter supplies supported parameters, context length, input/output modalities, maximum completion tokens, per-token prices and expiration date. ID-only Models APIs retain explicit manual capabilities/prices. A provider without a Models API retains manual entries. Failed syncs preserve the last successful catalog. A successful empty sync marks previously known models missing.
4. In **Roles**, choose chat/planner, quick, vision and coding primaries and ordered fallbacks. Missing role configs inherit chat. Chat/coding require tools; vision requires image input; the role's minimum context must fit. Disabled options show missing-capability reasons. The API enforces the same checks with explicit validation errors. Set max tokens (default 2048), optional temperature (0–2) and minimum context. Output is clamped to the catalog limit, including the smallest limit in a router fallback chain.
5. Set caching, privacy, optional latency preference, budgets and credit prices. Add a version note and select **Save configuration**; every save creates a candidate. Direct activation through this route is rejected; even the first saved version must pass the publish flow.
6. In **Evals**, select **Run eval N**. The API runs the golden JSON subset against both N and the current active config, then grades both through an independently selected judge (active quick/chat; first candidate when no active exists). Results are stored in `ai_eval_runs`. All hard checks must pass and candidate score must be at least active score minus 0.05. Missing/invalid judge output, transport failure or an active-version change fails closed. A prior result against another active version cannot unlock publication.
7. Select **Publish N**. An owner can explicitly override a blocked/missing eval by entering an 8–1000 character reason. Admins cannot override. The reason, actor, previous state and resulting state are audited. **Publish**, nonzero **Rollout** and **Promote candidate** all enforce the gate. Rollback to a never-published candidate also enforces it, preventing bypass.

Each write invalidates the local snapshot; PostgreSQL LISTEN/NOTIFY invalidates other instances, with a ten-second revision poll as a safety net. A request already sent finishes there. The next model request, including the next round of an existing task, sees the new active version. Key changes, emergency controls and spending checks also apply on the next request.

## Rollout and rollback

Select a candidate version and percentage in **Rollout**. New task assignments use a stable hash of owner ID and candidate version; 0% uses active and 100% uses candidate. A task’s assignment is persisted while that activation remains current. Changing a percentage does not move an existing task between cohorts. Promoting moves the active pointer to the candidate and clears rollout. It creates no copy and edits no version.

Configure caching flags, the cache TTL (`5m` or `1h`) and optional preferred maximum latency. Anthropic cache control marks the tools and stable system/memory boundaries. Compatible providers receive a stable conversation cache key when enabled; OpenRouter also receives the session ID and optional latency routing preference. These are hints: cache availability and enforcement depend on the provider. Worker planner calls use the additive streaming adapter; complete-response callers remain supported. See `SPEED.md` for buffering, fallback, and telemetry semantics.

In **Versions**, **Rollback to N** moves the pointer to any previously published version, clears rollout and starts a fresh activation generation. Running tasks cannot accidentally retain a candidate assignment from an earlier activation of N. No config snapshot is rewritten. A never-published version needs a passing eval before activation, or an explicit owner override via Publish. Provider deletion/model removal is refused when saved history references it, so rollback references are retained. Disabling or removing a provider/model required by saved history is refused.

The **Audit log** records each write with before/after metadata, active config and pointer changes. It excludes key bytes, ciphertext, suffixes and provider response bodies. Keep keys out of notes and override reasons.

## Retries, fallback and health

OpenRouter requests send `models: [primary, fallback, ...]` for configured fallbacks on that same provider and `provider.require_parameters: true`. Other providers use the in-house sequential fallback loop. No extra vendor routing service is involved. Calls record requested `model`, response `served_model`, provider ID, config version and whether a fallback served the call. Provider-reported cost is retained; when absent, catalog/manual per-token pricing estimates USD, including known cache rates.

Retries are limited to connection errors, timeouts, 429 and 5xx. Configure `retry.max_retries` (0–3, default 1), `allowed_fails` (default 3) and `cooldown_seconds` (1–3600, default 30). Backoff has jitter and honors Retry-After seconds or HTTP dates. Cancellation stops retries. Ordinary 4xx errors do not fall back; an active-key 401 has one rotation exception described below.

A breaker is scoped to provider/model in each API instance: closed → open after consecutive failed calls; after cooldown it admits one half-open probe; success closes it and failure reopens it. Open models are omitted from router arrays or skipped to the next fallback. Health shows local breaker states plus 24-hour call/error/fallback rates and p50/p95 latency from all instances. Breaker memory resets on API restart.

## Kill switch and paused tasks

**Overview** on both the dashboard and AI page prominently exposes three modes:

- **Stop all model calls** fails fast before credentials or upstream requests are used. Tasks enter a neutral resource wait; in-flight requests finish normally.
- **Pin every role to safe model** forces the designated configured model with no fallback escape. Validation checks configured role capabilities/privacy. A conflicting spend downgrade blocks rather than bypassing caps.
- **Resume configured calls** restores the configured routing.

Controls are audited. A short hosted scan resumes eligible model-control waiters after controls permit them; it fences the old worker lease and records resume events. It never resumes RunBudget/PauseOnBudget human pauses, approvals, or unrelated resource waits. Daily/monthly cap reset can make a waiter eligible on the next scan (15 seconds). Audio transcription retains its existing model/key contract; stop mode applies, and safe mode, privacy or a required downgrade pauses it because that endpoint cannot honor the selected chat-model routing contract.

## Spending caps and credits

**Overview** shows today's UTC spend, monthly spend by owner/bot and current caps. Configure USD caps in **Budgets**:

```json
{
  "plans": {"default": {"daily": 10, "monthly": 100, "action": "block"}},
  "users": {"OWNER_UUID": {"daily": 5, "action": "block"}},
  "bots": {"BOT_UUID": {"monthly": 20, "action": "downgrade", "downgrade": {"provider": "PROVIDER_UUID", "model": "CHEAPER_MODEL_ID"}}}
}
```

A zero cap blocks immediately; null/unset means unlimited. This deployment has no plan field, so owners use `default`. Plan and per-user limits both apply to the owner's total; per-bot overrides apply to that bot. Block wins over downgrade. A downgrade target must serve every configured role/privacy setting and have lower combined input/output catalog/manual prices than each primary. Calls check indexed rolling sums before sending, cache them for three seconds, and add local completed-call cost immediately. Concurrent requests and separate API instances can exceed a cap by in-flight cost or that short cache window; these are admission controls, not prepaid reservations. Unpriced usage cannot be valued; enter direct-provider prices before relying on USD caps. Existing task step/time budgets are unchanged.

Credit prices remain separate and admin-only:

```json
{"default":{"MODEL_ID":{"input_per_mtok":1,"output_per_mtok":3,"multiplier":1}}}
```

Credits are `(input × input_per_mtok + output × output_per_mtok) / 1,000,000 × multiplier`; absent entries are null. There is no balance deduction/grant system. Evals and their judges are model calls too: their usage contributes to spending and is recorded with role `eval`.

## Prompt caching and privacy

Caching flags control provider hints, not local answer reuse. Native Anthropic and Anthropic-family router requests mark the stable first/last system blocks and last tool definition as ephemeral cache breakpoints (up to three total, below the maximum four). Message/tool order is retained. TTL is `5m` or `1h`. When enabled, a stable conversation/task ID is sent as router `session_id`, and compatible requests receive a stable cache key. Turning caching off removes these hints.

A role's **Privacy** switch adds `provider: {require_parameters:true, zdr:true, data_collection:"deny"}` to router requests, alongside optional latency routing. Native direct endpoints require provider/account-level retention contracts and do not expose an equivalent enforceable per-request ZDR routing contract here. Privacy assignment to those providers is refused with a clear admin error. All privacy fallbacks and safe/downgrade targets must honor the role setting.

## Rotate keys without downtime

1. Expand **Key rotation slots**, enter **Next key**, then **Upload next**. The active key remains in service. Active, next and previous use the existing master-key AES-GCM encryption with provider-bound associated data.
2. Select **Test next slot**. Successful testing marks that exact stored upload; replacing it clears the test marker. Each slot has a Test control.
3. Select **Promote next key**. A transaction moves next to active, keeps the old active in previous and removes next. Promotion requires a successful test.
4. If needed select **Revert previous key**. This atomically swaps previous and active for quick recovery.

During preparation, an active 401 retries exactly once with next. No other 4xx rotation loop occurs. Admin responses expose only set/not-set, updated_at and test status. No last-four suffix, plaintext, ciphertext or nonce is returned or logged. Keep a separate secure backup of the master key; database backups cannot decrypt keys without it. Initial key setup uses the provider edit dialog or PUT `/providers/ID/key`; use slots for live rotation.

## Catalog alerts and performance

Overview warns when an active/candidate model has any expiration date, or disappears after a successful catalog sync. Disabled providers are not fetched. Catalog and alerts are available at `/api/admin/ai/catalog` and `/alerts`. The mock catalog includes an expiring model (`mock/retiring`) and a deliberately weak eval model (`mock/weak`); tests never contact paid providers.

**Speed** uses `/api/admin/speed` and shows No data yet for 404/empty results. The metrics endpoint comes from Phase 0. Streaming and complete-response calls share admission, routing, key rotation and retry controls. A stream can retry or fall back before its first content/tool delta; once content begins, a failure ends that attempt without switching models. Both paths record one model-call row with served model, usage, configuration and timing.

## API equivalents

Use a normal owner/admin session. Examples contain placeholders only. Put sensitive JSON in a protected file and keep credentials out of shell history.

```sh
ADMIN_URL='http://127.0.0.1:ADMIN_PORT'
curl -b SESSION_COOKIE_FILE "$ADMIN_URL/api/admin/ai"
# PROVIDER_JSON_FILE: {name,kind,base_url,enabled,models:[{id,tools,vision,context_tokens,...}]}
curl -b SESSION_COOKIE_FILE -H 'Content-Type: application/json' -X POST "$ADMIN_URL/api/admin/ai/providers" --data-binary @PROVIDER_JSON_FILE
# KEY_JSON_FILE: {"key":"KEY_VALUE"}; the initial upload returns 204.
curl -b SESSION_COOKIE_FILE -H 'Content-Type: application/json' -X PUT "$ADMIN_URL/api/admin/ai/providers/PROVIDER_UUID/key" --data-binary @KEY_JSON_FILE
curl -b SESSION_COOKIE_FILE -X POST "$ADMIN_URL/api/admin/ai/providers/PROVIDER_UUID/test"
curl -b SESSION_COOKIE_FILE -X POST "$ADMIN_URL/api/admin/ai/catalog/sync"
# CONFIG_JSON_FILE: {"as_candidate":true,"config":{"roles":{"chat":{"primary":{"provider":"PROVIDER_UUID","model":"MODEL_ID"},"fallbacks":[],"max_tokens":2048,"temperature":0.2,"privacy":false}}},"note":"Candidate switch"}
curl -b SESSION_COOKIE_FILE -H 'Content-Type: application/json' -X PUT "$ADMIN_URL/api/admin/ai/config" --data-binary @CONFIG_JSON_FILE
curl -b SESSION_COOKIE_FILE -X POST "$ADMIN_URL/api/admin/ai/versions/VERSION/eval"
curl -b SESSION_COOKIE_FILE -H 'Content-Type: application/json' -X POST "$ADMIN_URL/api/admin/ai/versions/VERSION/publish" -d '{}'
# Owner-only exceptional override: {"override_reason":"DOCUMENTED_REASON"} on publish.
curl -b SESSION_COOKIE_FILE -H 'Content-Type: application/json' -X PUT "$ADMIN_URL/api/admin/ai/rollout" -d '{"candidate_version":VERSION,"percent":10}'
curl -b SESSION_COOKIE_FILE -X POST "$ADMIN_URL/api/admin/ai/rollout/promote"
curl -b SESSION_COOKIE_FILE -X POST "$ADMIN_URL/api/admin/ai/versions/VERSION/rollback"
curl -b SESSION_COOKIE_FILE -H 'Content-Type: application/json' -X PUT "$ADMIN_URL/api/admin/ai/kill-switch" -d '{"mode":"stop"}'
# Use {"mode":"off"} to resume, or {"mode":"safe","safe_model":{"provider":"PROVIDER_UUID","model":"MODEL_ID"}}.
curl -b SESSION_COOKIE_FILE -H 'Content-Type: application/json' -X PUT "$ADMIN_URL/api/admin/ai/providers/PROVIDER_UUID/keys/next" --data-binary @KEY_JSON_FILE
curl -b SESSION_COOKIE_FILE -X POST "$ADMIN_URL/api/admin/ai/providers/PROVIDER_UUID/keys/next/test"
curl -b SESSION_COOKIE_FILE -X POST "$ADMIN_URL/api/admin/ai/providers/PROVIDER_UUID/keys/promote"
curl -b SESSION_COOKIE_FILE -X POST "$ADMIN_URL/api/admin/ai/providers/PROVIDER_UUID/keys/revert"
curl -b SESSION_COOKIE_FILE "$ADMIN_URL/api/admin/ai/providers/PROVIDER_UUID/keys"
curl -b SESSION_COOKIE_FILE "$ADMIN_URL/api/admin/ai/evals"
curl -b SESSION_COOKIE_FILE "$ADMIN_URL/api/admin/ai/health"
curl -b SESSION_COOKIE_FILE "$ADMIN_URL/api/admin/ai/spend"
curl -b SESSION_COOKIE_FILE "$ADMIN_URL/api/admin/ai/alerts"
curl -b SESSION_COOKIE_FILE "$ADMIN_URL/api/admin/ai/audit?limit=50"
curl -b SESSION_COOKIE_FILE "$ADMIN_URL/api/admin/ai/calls"
```

The CLI task smoke eval remains `evals/eval_real.py`. For explicit operator-run real golden evaluation, set `GOLDEN_PROVIDER_URL`, `GOLDEN_MODEL`, optional `GOLDEN_JUDGE_MODEL` and the provider key in the operator shell, then run `python3 evals/eval_real.py --golden evals/golden`. The JSON runner supports input, expectations and rubric, hard checks and an independent model judge. It is never part of CI and was not run against real providers here. The in-API gate uses the bounded core golden subset copied into the API image. Integration and browser specs must run on an isolated mock stack with ADMIN_URL; optional SHOT_DIR receives light/dark admin AI and Speed screenshots.
