# Skills v2

The existing `skills` table remains the deterministic recorded-step replay store. Replay tasks continue to use `tasks.skill_id` and the existing worker replay loop. Guide skills live in `skill_library`, keyed by owner and optional bot scope. The nullable `tenant_id` anticipates the tenant model without changing current owner scoping.

The worker obtains a capped, ordered catalog of names and one-line use cases. It does not receive bodies in that catalog. `load_skill` returns a body only when the skill belongs to the bot owner and is shared or scoped to that bot. Bot authored writes are limited to bot scoped skills with source `bot`; owners can author shared or bot scoped guides. Body length is capped at 32 KiB and strict DLP checks reject credential shaped content. Each bot update stores the previous body in `skill_revisions` and appends a platform audit event.

Built-in markdown guides live under `services/agent/skills/builtin` and are intended to be exposed read-only by the catalog provider. Tenant rollout can add `tenant_id` filtering alongside the existing owner predicate.
