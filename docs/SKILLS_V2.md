# Skills v2

Skills v2 adds reusable Markdown guides alongside the existing deterministic replay skills. The original `skills` table, `tasks.skill_id`, and replay worker path remain unchanged. Guide records use `skill_library`; each record has a nullable `tenant_id` for a future tenant migration and an `owner_id` for the current account boundary.

## Scope and catalog

A guide with no `bot_id` is shared with every bot owned by that account. A non-null `bot_id` makes it private to that bot. Names are lowercase slugs and unique within their owner or bot scope. Built-in Markdown files live under `services/agent/skills/builtin/`; their front matter provides `name` and `when_to_use`. The API seeds these as owner-scoped, bot-independent `builtin` rows and refuses owner update/revert and archive operations on them.

When a worker prepares a model call, it fetches a deterministic catalog ordered by source and name. The catalog contains only `name: when_to_use` lines, capped at 60 entries and 4,000 characters. Skill bodies are fetched only through `load_skill(name)`, which checks the current bot's owner and bot scope. Missing names return a clear error with up to three close matches. When the same name exists as a shared guide and a bot-specific guide, the bot-specific entry takes precedence.

## Writes, revisions, and audit

`write_skill(name, title, when_to_use, body)` uses the worker preexec check and the server’s full PolicyGate/approval-rules execution path and is classified as a low-risk `write`. The API limits Markdown bodies to 32 KiB in UTF-8, rejects secret-shaped values with DLP, then applies `OutputRedactor`. By default, a bot may create or update only bot-scoped skills authored by bots. The owner can opt a user-authored guide into bot editing with `allow_bot_edit`; built-ins cannot be opted in. A same-name shared owner or built-in entry cannot be overwritten by a bot without that explicit owner setting. Owners may create shared or bot-scoped guides and edit user or bot guides; built-ins remain immutable.

Every create writes an empty version-zero prior-body snapshot. Every update and revert records the body and version being replaced in `skill_revisions`, then increments the active version. Create, update, bot write, archive, and revert operations append a `platform.Audit` event. Owners can view the guide, inspect revision bodies and authors, edit, revert to a prior body, or archive it in the bot Skills pane.

An owner PUT that only enables `allowBotEdit` is still an update: a newly created guide moves from version 1 to 2, and the next authorized bot write produces version 3. A denied bot write leaves the guide and its revisions unchanged and creates no successful skill-write audit event.

## API

- `GET /api/bots/{bot}/skill-library` lists the bot's visible guides and seeds built-ins.
- `GET /api/skill-library/{id}` and `GET /api/skill-library/{id}/revisions` read owner-visible content and history.
- `POST /api/bots/{bot}/skill-library` creates a user-authored guide; optional `botId` scopes it to the current bot, otherwise it is shared.
- `PUT /api/skill-library/{id}`, `POST .../{id}/archive`, and `POST .../{id}/revert/{version}` manage owner guides.
- Worker-authenticated `/internal/skills/{bot}/catalog` serves the lazy catalog; model tools use `/internal/tools/preexec` and `/internal/tools/execute` with a task ID, bot ID, lease epoch and idempotency key. The scoped GET `/internal/skills/{bot}/{name}` remains available. The compatibility POST `/internal/skills/{bot}/write` requires the same execution envelope (`tool: "write_skill"`, `args`, task ID, matching bot ID, epoch) and delegates to the gated executor; bare guide bodies are rejected.

The browser's `Skills` pane shows guide source, use case, and update time, renders guide Markdown as text-safe headings, paragraphs, and list items, and provides revision review, revert, edit, and archive controls. Replay entries keep their existing replay button and do not enter the guide catalog.
