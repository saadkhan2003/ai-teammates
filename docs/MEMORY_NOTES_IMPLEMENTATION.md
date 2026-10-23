# Memory notes implementation slice

Milestones M1–M3 add migration 027, owner-scoped note storage and routes, guarded tool writes, reversible delete, search/update/forget by id or text, and server-side standing-rule validation. The worker receives bot role/instructions and newest-first rules with the task lease; rule text is user preference data and is never an input to PolicyGate. A rejected rule gets a short refusal message without echoing its contents.

Memory notes remain plain text in Postgres. Deletes can be restored for 10 minutes; the later retention milestone must purge note content and embeddings after that window. Rollback to an older API requires removing rows with `status` `deleted` or `superseded` before the old binary reads the table.

Defaults in this slice: `MEMORY_NOTES=shadow`, `Memory:InjectRole=true`, `Memory:RuleTokens=600`. Set `MEMORY_NOTES=on` to inject saved rules. Per-bot modes are `auto`, `ask`, and `off`; `off` disables note writes and rule injection for that bot.
