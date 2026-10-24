# Change AI providers and models

The owner and admins manage model routing at the separate admin site. Members receive HTTP 403 from every `/api/admin/ai` endpoint. The user app does not display provider names or model identifiers.

## Open the admin site

Rebuild the API, admin and Caddy images with the normal deployment procedure. Migration `044_ai_models.sql` runs automatically. The admin listener is `http://127.0.0.1:18082`; set `ADMIN_PORT` to change that loopback port. Use an SSH tunnel to access it remotely. `ADMIN_ALLOWLIST` optionally restricts the listener by client IP/CIDR, as seen by Caddy. Keep the admin port bound to loopback or put it behind your trusted TLS proxy. Never publish it on all interfaces.

For an isolated test stack, pass `--admin <unused-port>` to `scripts/gen-stack-compose.py`; the generator leaves out the admin publication unless explicitly requested. All bundled Caddyfiles include the separate admin listener. Sign in with an owner or admin account and open **AI models**.

## Add a provider and key

1. Select **Add provider**, enter a unique name, kind and base URL. Defaults are supplied for OpenRouter, Anthropic, OpenAI and Google's OpenAI-compatible API. For DeepSeek, Groq or vLLM, choose `openai_compatible` and enter its complete API base (usually ending in `/v1`). Anthropic accepts an origin or a base ending in `/v1`.
2. Add model IDs exactly as the provider expects them. Labels are optional; set vision, tools, caching and context size metadata as appropriate for each model. This list is an administrator-maintained catalog, not automatic discovery.
3. Paste the API key into the password field and save. Keys are encrypted using the existing AES-GCM master key, with provider-specific associated data. They are write-only: responses and audit records contain no key or ciphertext. The page shows only **Set / Not set** and the update time. Leave the field empty on an edit to retain the existing key.
4. Select **Test**. The API performs an authenticated models/key request with a ten-second timeout. It reports latency and a sanitized status, never a provider error body or key. A successful probe checks credentials/connectivity; it does not guarantee that every catalog model is available.

Use the complete base URLs, without credentials, query strings or fragments. Keep a separate backup of the existing master key; database backups alone cannot decrypt provider keys. Rotate a key by editing the provider and supplying a replacement. Redirects are disabled for authenticated provider requests so keys cannot follow a redirect to another host.

## Configure routing

Choose a primary for **Chat / planner**. Quick (classification and future quick acknowledgements/titles), vision (video summaries) and coding inherit chat until configured. Add fallbacks in their intended order; use **Move up** to reorder them. Only enabled providers and catalog models can be saved. Model metadata describes capabilities; administrators must select models suitable for their tools and image inputs.

Configure caching flags, the cache TTL (`5m` or `1h`) and optional preferred maximum latency. Anthropic cache control marks the tools and stable system/memory boundaries. Compatible providers receive a stable conversation cache key when enabled; OpenRouter also receives the session ID and optional latency routing preference. These are hints: cache availability and enforcement depend on the provider. Worker planner calls use the additive streaming adapter; complete-response callers remain supported. See `SPEED.md` for buffering, fallback, and telemetry semantics.

The credit price editor takes a plan-to-model JSON map:

```json
{"default":{"MODEL_ID":{"input_per_mtok":1,"output_per_mtok":3,"multiplier":1}}}
```

This deployment has no user plan/balance fields. All calls use `default`. Credits equal `(input_tokens × input_per_mtok + output_tokens × output_per_mtok) / 1,000,000 × multiplier`. Anthropic input includes uncached input, cache reads and cache creation. The map prices total input uniformly. Missing entries produce a null credit amount, and provider-reported USD cost remains separate. There is no account balance deduction or monthly grant system. Recent call credits and served provider/model/version are available at `/api/admin/ai/calls` only.

Enter a note and select **Save configuration**. A new immutable routing version becomes active. Every API instance receives a PostgreSQL notification and drops its cached snapshot; a revision check every ten seconds covers missed notifications. The local process invalidates its cache immediately after the write.

A request already sent to a provider finishes there. The next model round, including the next round of a running chat/task, resolves the new active version. There is no restart or worker redeploy. Python workers continue to call the API gateway and never receive provider credentials. A task retains its rollout version choice while the active version remains unchanged, even if rollout percentage changes; changing the active version reroutes the next round. A transient failure uses a fallback for that call only, and the next call starts at the primary again. The provider that served a successful call and the resolved version are recorded in `model_calls`. Cancellation, invalid credentials and ordinary 4xx failures do not trigger retries; connection errors, provider timeouts, 429 and 5xx try the next configured fallback. Existing policy, DLP, tool approval and budget checks remain in place.

Video summaries use the vision role. Speech-to-text retains its separate existing `VIDEO_STT_MODEL` / `VIDEO_STT_PROVIDER` transcription contract and per-user connection key; this registry does not add native speech adapters.

Provider deletion, disabling or removal of models is refused while active, rollout-candidate or task-pinned configuration references require them. Historical configs can retain deleted provider IDs; rollback validates the copied configuration against today's enabled catalog, so restore the provider/model first if validation fails.

## Roll out and roll back

Save a changed config with **Save as rollout candidate** checked. An active saved config must already exist. The candidate starts at 0%; it does not replace the active config. Select its version and set the percentage in **Rollout**, then **Save rollout**. New tasks use a stable SHA-256 bucket of user ID plus candidate version; 0% uses active, and 100% uses candidate. A user's tasks get the same choice for an unchanged rollout. Existing tasks stay pinned within the active version. The rollout candidate's own rollout metadata is ignored.

**Promote candidate** copies its routing into a new active version and clears rollout. In **Versions**, **Rollback to N** copies version N into a *new* active version, clears rollout and records the action. It never rewrites or reactivates the old version number. Use the audit log to see who changed providers, keys, config or rollout. Notes and audit data must never contain keys.

**Speed** renders `/api/admin/speed` metrics and p50/p95 targets. It shows **No data yet** when the metrics endpoint has not been deployed or contains no samples. That endpoint is supplied by the separate speed-metrics change.

## Environment bootstrap

With no saved config, version 0 is synthesized from `LLM_PROVIDER`, `OPENROUTER_BASE_URL` and `MODEL_PLANNER`, using the existing per-user `secret://openrouter/default` resolution and permission/audit path. Existing deployments, including `LLM_PROVIDER=mock`, continue to work without any admin configuration. The bootstrap still waits for the existing connection key when one has not been stored. Environment configuration remains the default until the first saved active version; afterwards saved config takes precedence. Bootstrap version 0 is not a persisted version and cannot be a rollback target. Save an explicit copy of your legacy routing as your first admin version if you need a rollback baseline. No runtime API operation deletes config history to return to bootstrap.

## API equivalents

Use a session cookie obtained by the normal login flow. Replace the placeholders below; never commit a real key, cookie or password to a script. Put sensitive request JSON in a temporary protected file rather than a shell command/history. All writes are audited and lightly rate limited (HTTP 429 when exceeded).

```sh
ADMIN_URL='http://127.0.0.1:ADMIN_PORT'
curl -b SESSION_COOKIE_FILE "$ADMIN_URL/api/admin/ai"
curl -b SESSION_COOKIE_FILE -H 'Content-Type: application/json' \
  -X POST "$ADMIN_URL/api/admin/ai/providers" \
  -d '{"name":"Primary","kind":"openai_compatible","base_url":"https://PROVIDER_HOST/v1","enabled":true,"models":[{"id":"MODEL_ID","label":"Chat","tools":true,"vision":false,"caching":true,"context_tokens":128000}]}'
# KEY_JSON_FILE contains {"key":"YOUR_KEY"}; this endpoint returns 204.
curl -b SESSION_COOKIE_FILE -H 'Content-Type: application/json' \
  -X PUT "$ADMIN_URL/api/admin/ai/providers/PROVIDER_UUID/key" --data-binary @KEY_JSON_FILE
curl -b SESSION_COOKIE_FILE -X POST "$ADMIN_URL/api/admin/ai/providers/PROVIDER_UUID/test"
# PUT /providers/PROVIDER_UUID accepts the same metadata as POST, excluding a key.
curl -b SESSION_COOKIE_FILE -H 'Content-Type: application/json' \
  -X PUT "$ADMIN_URL/api/admin/ai/config" \
  -d '{"config":{"roles":{"chat":{"primary":{"provider":"PROVIDER_UUID","model":"MODEL_ID"},"fallbacks":[]}},"caching":{"enabled":true,"anthropic_cache_control":true,"session_id_per_conversation":true,"ttl":"5m"},"latency":{"preferred_max_latency_ms":1500},"credit_prices":{"default":{"MODEL_ID":{"input_per_mtok":1,"output_per_mtok":3,"multiplier":1}}},"rollout":{"candidate_version":null,"percent":0}},"note":"Switch primary"}'
curl -b SESSION_COOKIE_FILE "$ADMIN_URL/api/admin/ai/versions"
curl -b SESSION_COOKIE_FILE -X POST "$ADMIN_URL/api/admin/ai/versions/VERSION/rollback"
# To create a candidate, add "as_candidate":true to the config request body.
curl -b SESSION_COOKIE_FILE -H 'Content-Type: application/json' \
  -X PUT "$ADMIN_URL/api/admin/ai/rollout" -d '{"candidate_version":CANDIDATE_VERSION,"percent":10}'
curl -b SESSION_COOKIE_FILE -X POST "$ADMIN_URL/api/admin/ai/rollout/promote"
curl -b SESSION_COOKIE_FILE "$ADMIN_URL/api/admin/ai/audit?limit=50"
curl -b SESSION_COOKIE_FILE "$ADMIN_URL/api/admin/ai/calls"
curl -b SESSION_COOKIE_FILE -X DELETE "$ADMIN_URL/api/admin/ai/providers/UNUSED_PROVIDER_UUID"
```

Use the secret management API for the legacy per-user bootstrap key. Admin provider keys do not overwrite those user secrets. Provider CRUD responses explicitly project safe metadata; config and versions never contain keys.
