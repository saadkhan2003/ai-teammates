# Structured task briefs

`spawn_child_task` accepts a title and a structured `brief`. The API validates it, performs a deterministic quality check, attaches bounded supporting context and renders the child instruction. The original worktree confinement prefix remains first. A child is a work task and retains the existing maximum depth/active-child limits. Child creation never pushes or merges. Git worktree commands resolve to the bot-private filesystem root; the instruction retains the virtual /workspace path. Spawn retries use the existing tool-execution dedupe ledger.

The built-in `writing-a-great-brief` guide contains principles and four canonical examples: visual polish, a reproduced bug, a private backend feature and a sourced research report. It is seeded through the existing built-in guide catalog, cannot be edited/deleted/reverted by users, and is also referenced in the worker's system prompt and tool description. Load its body with `load_skill` before delegating.

## Schema

```json
{
  "title": "Polish chat typography",
  "repo": "project",
  "brief": {
    "brief_version": 1,
    "goal": "Chat text matches the reference stroke weight in both themes.",
    "kind": "ui",
    "priority": "high",
    "effort": "medium",
    "budget": "One focused pass, at most 30 tool calls",
    "context": "Saad said ‘the text looks bold and heavy’; he is frustrated. Preserve notes 36 and 41.",
    "references": [
      {"kind":"note","path_or_url":"/workspace/ui-handoff/SAAD_UI_NOTES.md","why":"Exact typography values in notes 36/41"},
      {"kind":"screenshot","path_or_url":"/workspace/uploads/2026-10-24/ref.png","why":"Visual target at equal zoom"}
    ],
    "scope": {"in":["apps/web"],"out":["apps/api","services/agent"]},
    "non_goals": ["No navigation or behavior changes"],
    "rules": ["Inter variable body 380–400, labels 450–500, headings <=600; dark primary #e7e9ea"],
    "checklist": ["Audit chat, sidebar, Library, tabs and dialogs"],
    "acceptance": [
      {"criterion":"Both themes match the reference stroke weight", "check":"Playwright typography snapshot and equal-zoom side-by-side crops of chat, sidebar and Library"}
    ],
    "assumptions": ["Keep note-36 type sizes"],
    "open_questions": [],
    "gate": "Push only after all suites and acceptance checks are green.",
    "report_back": "Light+dark crop paths, snapshot evidence, per-suite pass/fail/skip counts and commit SHA"
  }
}
```

Required fields: `goal`, `context`, non-empty `acceptance`, `report_back`. Context may also be an object containing `quote`, `author`, `mood`, `background`/`why`; the renderer preserves the supplied text. Goal is one or two outcome sentences. `kind` is feature (default), bugfix, ui, refactor, research or ops. Priority is low/normal/high/urgent; effort is small/medium/large. Both and the free-text budget are optional. References have kind file/screenshot/note/url/library, path_or_url and why. Scope, non_goals, rules, checklist and assumptions are optional but improve quality. The default gate is “Do not push or merge until every acceptance check passes.” The API stamps `brief_version: 1`; the persisted version is exposed independently as `version`.

Bugfix briefs also require `repro: {steps, current, expected, unchanged}`. Steps may be text or an array. Each acceptance item requires a criterion and a concrete check; “works”, “looks good”, “make sure it works” and other bare checks are rejected. Exact test names/commands, snapshots, screenshots, comparison crops or research source audits are appropriate. Every open question has `{question, blocking: boolean}`; a blocking question prevents delegation until the bot calls `ask_user` and incorporates the answer.

`instruction` remains an optional legacy fallback for goal. It does not supply the other required fields. Optional `brief` also works on `message_bot`, `create_routine` and `update_routine`; those validate goal/report_back and render to text/instruction. Without a brief they retain existing behavior. Existing peer size limits, same-owner privacy, routine read-before-edit requirements and approvals still apply. Routine create/update timestamps are normalized to UTC for PostgreSQL while retaining the owner’s schedule timezone. Routine/peer instructions receive rendered brief text; `task_briefs` records are for spawned child tasks.

## Correction and quality

Validation failures are fixable results with `ok: false`, `status: "brief_rejected"` and `issues: [{field,message}]`. The message gives a concrete fix. `needs_clarification` tells the bot to ask the user with a question card first. These results do not count as invalid-tool loops in the worker. Nothing is spawned for a rejected brief.

`BriefQuality` independently scores goal clarity, context/why, references, scope/non-goals, rule specificity, acceptance checkability, verification, gate, report-back and decomposition on 0..1 scales. The mean threshold is 0.7. A valid first low-scoring attempt returns `brief_needs_rewrite` with the top issues. State is persisted per parent task + normalized child title so restarting a worker does not reset the rewrite pass. The next valid low-scoring submission is accepted with warnings and its actual failing score; it is not silently marked passed. More than eight acceptance items or more than three distinct app/service areas produces a split suggestion.

Optional model review is **off by default**. Set `Brief:ModelReview=true` (environment `Brief__ModelReview=true`) and configure `MODEL_QUICK` to enable it. It uses the existing internal model gateway/SecretBroker/provider wire/usage ledger with role `quick`, JSON output, 256 output tokens and a three-second cancellation timeout. Its warnings supplement the rubric; timeout, malformed output and provider errors are ignored. Mock and unit tests do not contact a paid provider. Thought time always comes from the latest successful **planner** model-call latency for the parent turn, excluding the optional reviewer; zero means no timing was recorded.

## Persistence, context and learning

Forward-only migrations **047_task_briefs.sql** and **048_brief_lessons.sql** are explicitly listed after 042 in Platform and the API Dockerfile. Numbers 043–046 are reserved for the parallel program; the explicit migration runner supports gaps.

`task_briefs` stores task/bot/conversation/parent IDs, scrubbed structured JSON, deterministic Markdown, quality JSON, thought_ms, version and creation time. `task_brief_steering` stores user notes and actors. Briefs have the same visibility as tasks/workspaces: only the owning account can read/steer them; being staff does not grant access to another bot. Current task routes have no shared-bot membership grants, so no broader grant is introduced here.

Auto-context reuses MemoryStore retrieval and its memory opt-outs, adds bot-owned unscoped standing preferences with the same sensitive/origin filters as worker lease context, the latest five bot-only lessons, up to five recent uploaded paths from this conversation's last twelve user messages/attachments, and clean Library items attached/referenced by ID or exact name in the conversation. It reads paths/metadata rather than uploaded file contents. Category budgets keep the complete context below roughly 1500 characters while reserving room for uploads and Library references. Every injected string crosses the existing OutputRedactor, DLP and InjectionFilter before truncation. Auto-context is explicitly supporting material; it cannot authorize actions or override the user's brief.

Steering is both recorded and delivered before the running child's next model step. The worker fetches notes under its current task epoch and persists `[brief-steering:<id>]` in transcript content. Those markers survive canonical transcript storage, restarts and compaction, so a note is not delivered twice. Steering of a finished task remains history/learning and does not restart it. Notes submitted during an in-flight model/tool call take effect on the following model step.

`brief_lessons` is private per bot/owner and deduplicates normalized case/whitespace. Steering records source `steer`; a database status-transition trigger records `failed_run` for all brief-task failures/cancellations, including sweeps. The failure reason/title are trimmed, and all lesson reads/injection use the existing secret guards. Lessons describe prior context, not authorization. Owners may list/delete lessons; deletions and steering are audited.

## API contract

- `GET /api/tasks/{id}/brief`: 200 with `{taskId,title,version,markdown,brief,quality:{score,passed,issues:[{field,message}],warnings:[],dimensions,splitSuggestion},thoughtSeconds,references:[{kind,path,name,url}],steering:[{id,text,createdAt}],status,createdAt}`. Missing task/brief is 404, another owner's task is 403, no session is 401. `url` is null for filesystem references and only HTTP(S) links are emitted as URLs.
- `POST /api/tasks/{id}/brief/steer {text}`: 202 `{id,text,createdAt}`. Empty/whitespace, text stripped to empty or more than 4000 characters is 400. Other owner is 403. Emits `brief.steered` audit and task refresh events.
- `GET /api/bots/{id}/brief-lessons`: owner-only array `{id,lesson,source,sourceTaskId,createdAt}` (latest 100).
- `DELETE /api/bots/{id}/brief-lessons/{lessonId}`: owner-only 204; unknown lesson 404. Audited.
- `POST /api/test/briefs/seed {botId,conversationId?}`: only when ENABLE_TEST_HOOKS is true; otherwise 404 before authentication/database access. Authenticated owner only; verifies conversation belongs to the bot. Creates a completed parent, waiting_human child, sample brief with 4.25 thought seconds and an assistant message. Returns `{taskId,parentTaskId,conversationId,messageId}`. No model/compute call and no automatic child execution.
- Internal `GET /internal/tasks/{id}/brief/steering?epoch=N`: worker token plus a running task/current epoch are required. Returns `{steering:[...]}`; stale epoch is 409.

Chat linkage is calculated in the shared `Routes.LoadMessages` used by **workspace and paginated messages** endpoints. Assistant messages with `messages.task_id` (returned as `requestId`) carry optional `childTasks: [{taskId,title,status,hasBrief}]`, matching `tasks.parent_task_id` and the same conversation **and bot**. This is durable rather than inferred from message text. The spawn tool inserts an immediate assistant message bound to the parent so the brief is visible even before the parent finishes. All assistant messages for that parent turn resolve to the same child list; the UI may group it by task ID. User messages never receive child cards. Live status is queried on each load.

## Evals and validation

`evals/briefs/golden.jsonl` has fifteen diverse asks, structured fixture briefs and expected must-have elements/behavior. CI uses deterministic mock judgments, including clarification and split outcomes, with no network access. Checked-in Markdown is generated by the **actual C# BriefRenderer**; C# tests compare every fixture byte-for-byte and pytest judges those artifacts. Refresh fixtures after an intentional renderer change:

```sh
dotnet run --project evals/briefs/render-fixtures
```

`judge.py` exposes a single-call JSON rubric judge and validates every dimension, boolean pass/fail and one-line reason. `run_real.py` is operator-only, forbidden in CI, requires explicit `--allow-paid`, LLM_PROVIDER=openrouter, an env-only OPENROUTER_API_KEY and a configured cheap model. Its default and maximum spend cap is $0.05. Positive conservative input/output price ceilings are mandatory and enforced through provider max_price. Before each generation/judgment it GETs /api/v1/key, reserves a byte-bounded prompt plus maximum output cost, refuses calls over the remaining cap, and GETs usage again after every attempted call. Reservations never decrease even if accounting lags; missing usage accounting fails closed. It writes redacted results JSON and a Markdown summary. **Do not run this script in CI or in a mock-only coding session.**

C# tests cover validation/fix hints, golden rendering, thresholds/one rewrite, reviewer failure/mock behavior, context redaction, real PostgreSQL storage/linkage, owner privacy/403, steering epochs, deduped lessons, lifecycle failure triggers and hooks-off 404. Python tests cover steering/restart/compaction, guide/prompt/correction behavior, mock planner repair, golden judgments and spend-cap accounting with mocked transport. `tests/integration/test_briefs.py` exercises seed/read/steer/cancel lessons plus a real mock-planner rejection/rewrite/child-failure flow; run against an isolated Docker-capable mock stack. Live integration, chaos and Playwright are orchestrator responsibilities in the restricted coding sandbox.
