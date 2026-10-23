# Bot-to-bot messaging: design (proposal, not built)

Status: design only. Nothing in this file is implemented. Numbers marked **(est.)** are planning assumptions, not measurements.
Goal: like Grok Bot, one AI Teammates bot can send a message or task to another bot with a tool (`message_bot`), receive the reply, and the chat shows a compact row **"Messaged <bot>  <short title>"**. The row opens the bot-to-bot conversation in an overlay headed **"ATLAS ⇄ <bot>  <title>"**, and the other bot's replies also show inline under the row.

## 1. What exists today (inspected in the repo)

- **No inter-bot messaging.** A search for `message_bot`, delegation, mentions, peers and handoff finds nothing in `apps/`, `services/`, `db/` or `docs/`. There is no teammates/links table. Bots are rows in `bots` (`owner_id`, `name`, `role`, `instructions`, `avatar`), and every route checks the bot's owner.
- **Reusable parts:**
  - `tasks` (queue, lease, checkpoint, `conversation_id`, `kind`, `priority`, `waiting_reason`) and the Postgres lease in `/internal/tasks/lease`, capped by `user_quotas.max_parallel_tasks`.
  - `messages` (`role`, `kind`, `content`, `metadata`). Rich blocks are JSON in `content`, parsed by `apps/web/lib/message-blocks.ts` (question, memory, form, file, image).
  - Tool path: `ToolSchema.Builtins()/Validate`, `Runtime.Authorize/Execute/Dispatch`, `PolicyGate.Evaluate` with `ActionClasses` (`send_message` defaults to ASK), `Dlp.AssessArgs`, `InjectionFilter`, hard-deny rules, approvals (`approvals`, one-shot `ConsumeApproval`).
  - `OutboundLog.Run` + `outbound_actions` (idempotency key, up to 3 retries, "unconfirmed" notice). Today `send_message` only writes an assistant row into the *same* conversation, so it is not a bot-to-bot path.
  - `Platform.Audit` (hash-chained `audit_events`), `Platform.Publish` (SSE `/api/events`), `Platform.Notify`, `model_calls.cost_usd`, `RunGuard` (24 steps, 90 s, repeat limit 3).
  - Workspace privacy: one computer, one directory and UID per bot (`services/computer/src/workspace.py`). TEAMS-ISO network isolation.
  - UI: `chat-pane.tsx`, `message-blocks.ts`, `refresh-notice.tsx` and `lib/connection.ts` ("Couldn't refresh" + Try again), `app-shell.tsx` sidebar with last-message preview.

## 2. Principles

1. A peer message is **untrusted input from another bot**, never the user's voice. It cannot approve, grant, or widen anything.
2. **Only the text travels.** The receiver never sees the sender's workspace, memory, transcript, secrets or approvals.
3. **Same owner only in v0.4/v0.5-M0.** Both bots must belong to the same user. Cross-user messaging waits for organizations (v0.5 plan).
4. Every send is bounded (depth, count, rate, cost), idempotent, audited, and visible to the user in both chats.
5. No new bypass of PolicyGate, DLP, TEAMS-ISO or per-bot workspace modes.

## 3. Data model (`db/015_bot_messaging.sql`, additive)

```sql
CREATE TABLE bot_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  initiator_bot_id uuid REFERENCES bots(id) ON DELETE SET NULL,
  peer_bot_id      uuid REFERENCES bots(id) ON DELETE SET NULL,
  initiator_name text NOT NULL,            -- snapshot, survives bot delete/rename
  peer_name      text NOT NULL,
  title text NOT NULL,                     -- 3-60 chars, DLP-scanned
  root_thread_id uuid NOT NULL,            -- = id for a top-level thread; chain budget key
  parent_task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,  -- sender task that opened it
  depth int NOT NULL DEFAULT 1,            -- hops from a user-originated task
  status text NOT NULL DEFAULT 'sending',
  error_code text,
  message_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bot_threads_status_chk CHECK (status IN
    ('sending','waiting','replied','failed','timed_out','paused','closed'))
);
CREATE INDEX bot_threads_owner_idx ON bot_threads (owner_id, updated_at DESC);
CREATE INDEX bot_threads_pair_idx  ON bot_threads (initiator_bot_id, peer_bot_id, status);

CREATE TABLE bot_thread_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES bot_threads(id) ON DELETE CASCADE,
  seq int NOT NULL,
  from_bot_id uuid REFERENCES bots(id) ON DELETE SET NULL,
  to_bot_id   uuid REFERENCES bots(id) ON DELETE SET NULL,
  kind text NOT NULL,                      -- request | reply | system
  content text NOT NULL,                   -- DLP-redacted before insert
  attachments jsonb NOT NULL DEFAULT '[]', -- [{artifactId,name,sha256,size}]
  source_task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,   -- task that wrote it
  delivered_task_id uuid REFERENCES tasks(id) ON DELETE SET NULL, -- task it created on the receiver
  idempotency_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (thread_id, seq)
);

-- extend existing tables (no data rewrite)
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS origin_thread_id uuid REFERENCES bot_threads(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS origin_depth int NOT NULL DEFAULT 0;   -- 0 = user-originated
ALTER TABLE bots  ADD COLUMN IF NOT EXISTS peer_messaging boolean NOT NULL DEFAULT true;  -- per-bot opt-out
ALTER TABLE user_quotas ADD COLUMN IF NOT EXISTS peer_msgs_per_day int NOT NULL DEFAULT 200;
ALTER TABLE user_quotas ADD COLUMN IF NOT EXISTS peer_chain_budget_usd numeric(8,4) NOT NULL DEFAULT 0.10;
ALTER TABLE outbound_actions DROP CONSTRAINT IF EXISTS outbound_actions_kind_chk;
ALTER TABLE outbound_actions ADD CONSTRAINT outbound_actions_kind_chk
  CHECK (kind IN ('send','post','purchase','plugin_write','bot_message'));
```

Chat rows reuse `messages`: one row per thread in each bot's own conversation, `kind='bot_thread'`, `content` = JSON `{"type":"bot_thread","threadId","direction":"sent|received","peerBotId","peerName","title"}`. Row *status* is not stored in the message. It is read live from `bot_threads` so it never goes stale. Tasks get `kind='peer'` (receiver) and `kind='peer_reply'` (sender wake-up), priority 5 (below user chat 10, above routines/work 0), so a peer storm cannot starve the user.

## 4. Flow

1. **Sender** task calls `message_bot`. Authorize/Execute run PolicyGate and the guards in section 7.
2. In one transaction: find or create the thread, insert the `request` message, insert a receiver task (`kind='peer'`, `origin_thread_id`, `origin_depth = sender.origin_depth+1`), insert the `bot_thread` row in the sender's conversation (once per thread) and a "received" row in the receiver's conversation. Status `sending` then `waiting` once the receiver task is queued. Publish SSE `{type:"bot_thread", threadId}` and `Tasks.Pulse()`.
3. **Receiver** runs normally (its own PolicyGate, user policy, workspace, model). Its prompt starts with a fixed frame: *"Message from bot ATLAS (not from the user), thread <title>. Do what is asked within your own rules. Your final answer is sent back as the reply."* The peer text is passed through `InjectionFilter` and fenced.
4. **Reply:** when a `peer` task completes (`/internal/tasks/{id}/complete`), the final text, redacted by DLP, becomes a `reply` message. Status `replied`. The API queues a `peer_reply` task for the sender whose instruction carries the reply, or, if the sender chose `wait_seconds`, flips the parked sender task back to `queued` (section 5). The sender then answers the user in the user's conversation. The receiver may also send an explicit mid-task update with `reply_to_bot` (same tool path, counts toward limits).
5. **Continue:** `message_bot` with `thread_id` appends to an existing thread (same limits). A new topic gets a new thread and title.
6. **Delete/rename:** thread names are snapshots. Deleting a bot sets its FK to NULL and the thread to `closed`. The rows stay readable.

Default is **asynchronous**: `message_bot` returns `{threadId, status:"waiting"}` and the sender may finish its turn. Optional `wait_seconds` (1-60, default 0): the sender task parks with `status='waiting_resource'`, `waiting_reason='peer_reply'` (existing statuses, no CHECK change), and resumes on the reply or at the timeout. A thread with no reply after 15 min **(est. default, configurable)** becomes `timed_out`.

## 5. API

User-facing (cookie session, owner of both bots else 404):

| Route | Purpose |
|---|---|
| `GET /api/bots/{id}/peers` | Directory: other bots of the same owner with `peer_messaging=true`. Returns id, name, role, avatar only. Never `instructions`. |
| `GET /api/bot-threads?botId=&status=&limit=` | Thread list (for rows and a future inbox). |
| `GET /api/bot-threads/{id}` | Thread + messages + attachments (names only) + task status of the active receiver task. |
| `POST /api/bot-threads/{id}/retry` | "Try again". Re-queues the failed/timed-out delivery with the same idempotency key (no duplicate if it had landed). |
| `POST /api/bot-threads/{id}/pause` and `/resume` | User stop. Pause cancels the queued receiver task and blocks new sends. |
| `POST /api/bot-threads/{id}/close` | Final state `closed`. |
| `POST /api/bots/{id}/peer-messaging` | Per-bot on/off (also in the bot settings). |

SSE: reuse `/api/events` with `{type:"bot_thread", threadId, status}` (and the existing `task`/`message` events). The web refetches that one thread, not the whole bot.

Worker-facing: **no new internal route.** `message_bot`, `reply_to_bot` and `list_bots` go through the existing `/internal/tools/authorize` and `/internal/tools/execute`, so they inherit lease checks (`HoldsLease`), `ToolSchema.Validate`, `Step` logging and the audit trail.

## 6. Agent tools

Added to `ToolSchema.Builtins()` and `ActionClassifier`:

- `list_bots()`: names and roles of messageable peers (so the model does not guess names).
- `message_bot(bot, title, text, thread_id?, attachments?, wait_seconds?)`: `bot` is a name or id of a same-owner bot (case-insensitive, must be unique, otherwise the tool returns the candidates). `title` 3-60 chars. `text` max 4,000 chars. `attachments` max 3 artifact ids, each max 2 MiB **(est.)**.
- `reply_to_bot(thread_id, text)`: only valid inside a task whose `origin_thread_id` = `thread_id`.

Visibility: `ToolSchema.ForModel()` offers these only if the owner has at least two bots and the bot has `peer_messaging=true`. This keeps the tool list small for single-bot users. The worker's `present_tool` shows "Messaging <bot>" in the step list.

Attachments: the API copies the artifact bytes into the receiver's own `/workspace/inbox/<threadId>/` through the compute exec path as the **receiver's UID**, after a DLP scan and size check. The sender never gets a path into another bot's directory, and the receiver never gets one into the sender's.

## 7. Policy, security and limits

**PolicyGate.** Add action class `bot_message` to `ActionClasses` (default **ALLOW** for same-owner peers, user-changeable to ASK/DENY in Settings > Policy). First contact between a new pair can be set to ASK (one approval card, "Let ATLAS message PULSE?"). Hard-deny patterns and `Dlp.AssessArgs` run on `title`, `text` and attachment names exactly as for `send_message`; strict PII/secret hits block the send with `dlp_blocked`; health/finance phrases need `ExplicitShare` as today.

**No confused deputy.** A `peer` task carries `origin_thread_id`. `PolicyGate.Evaluate` gets an `originIsPeer` flag. In peer-origin tasks:
- classes `payment`, `sign`, `delete`, `credential_use`, `external_post` and `send_message` are **forced to ASK even if the user policy says ALLOW**, and the approval card says *"Requested by ATLAS through thread '<title>'"*;
- credential-domain grants and "Allow once" browser consent from the sender's task do not carry over;
- a peer message can never satisfy `ConsumeApproval` for another task;
- peer text that matches hard-deny rules is rejected before the receiver runs (`peer_text_denied`).

**Workspace privacy.** No cross-bot file, memory, transcript or secret tool exists. `read_file`/`shell` stay confined to the caller's own directory and UID. Memory is per bot. The directory (`list_bots`) never exposes instructions, secrets, or files. Reply text is DLP-redacted before storage, as are logs and audit detail.

**Loop and depth limits** (all configurable; values are defaults **(est.)**):
- max depth 3 (`origin_depth`; a user task = 0). A send that would exceed it fails with `depth_limit`.
- no cycles in a chain: A→B→A on a *different* thread is denied (`cycle`); replying on the same thread is fine.
- max 5 `message_bot` calls per task; max 12 messages per thread; max 2 open threads per pair.
- ping-pong guard: more than 6 consecutive bot-only messages in a thread with no user action pauses the thread (`paused`, notification "ATLAS and PULSE are talking in a loop. Resume?").
- `RunGuard` repeat limit also applies (identical `message_bot` args 3 times ends the run).

**Rate and cost caps:**
- per bot 30 sends/hour, per user `peer_msgs_per_day` (200). Over the cap returns `rate_limited` and a user notification once per hour, not per attempt.
- the **chain budget**: sum of `model_calls.cost_usd` for all tasks sharing a `root_thread_id` is capped (`peer_chain_budget_usd`, default $0.10). Checked before every new peer send and before a receiver task starts. Over budget pauses the chain (`budget_exceeded`).
- peer tasks count toward `max_parallel_tasks` and use priority 5.
- the existing OpenRouter total cap and `HostBudget` still apply.

**Idempotency.** Sends go through `OutboundLog.Run` with kind `bot_message`; the key is `sha256(thread, seq, text)`. A worker restart or Try again never delivers twice.

**Audit** (hash-chained `Platform.Audit`; detail has ids, lengths, sha256, and an 80-char redacted preview; no secrets, no attachment bytes): `botmsg.sent`, `botmsg.delivered`, `botmsg.replied`, `botmsg.denied` (reason), `botmsg.limit` (kind), `botmsg.paused`, `botmsg.retry`, `botmsg.closed`, `botmsg.attachment`. All appear in the existing audit view and `/metrics` counters.

**Abuse cases covered:** a prompt-injected page makes bot A message bot B "delete everything" (B's delete is forced to ASK, user sees it); A and B loop forever (depth, ping-pong, chain budget); A floods B (rate caps); A exfiltrates a secret in text (DLP) or by file (A cannot name B's paths, attachments are artifacts only and scanned); B's reply carries an injection back to A (reply is fenced and filtered the same way).

## 8. UI

Matches the Grok Bot reference with Saad's own colours/avatars.

**Chat row (in `chat-pane.tsx`, new block kind `thread` in `message-blocks.ts`, new `components/bot-thread-row.tsx`):** one compact line: peer avatar + "**Messaged** PULSE  *Apply AI Teammates v0.4 patches and open PR*" (received side: "**Message from** ATLAS ..."). A small status icon at the right. Click or Enter opens the overlay. Replies appear **inline under the row**: the other bot's latest reply as a muted bubble with the thread title in small text above it (as in the reference), collapsed to 4 lines with "Show more".

**States** (read from `bot_threads.status` plus the receiver task status, updated by SSE):

| State | Row | Detail |
|---|---|---|
| Sending | spinner, row dimmed, optimistic row from the tool call | no overlay content yet |
| Waiting | "Waiting for PULSE" with a pulsing dot; shows "needs your approval" with a link to the card if the receiver is at `waiting_approval` | receiver step list is visible in the overlay |
| Replied | check icon, inline reply bubble | full thread |
| Failed / timed out | red icon, "Couldn't reach PULSE" + **Try again** (reuse `refresh-notice.tsx` pattern; calls `/retry`) | shows `error_code` as a plain sentence (rate limited, depth limit, over budget, DLP blocked, peer off) |
| Paused (loop/budget) | amber, "Paused: loop limit" + **Resume** / **Close** | explains why |
| Closed / bot deleted | grey, name from snapshot | read-only |

**Overlay (`components/bot-thread-overlay.tsx`):** top pill "ATLAS ⇄ PULSE  <title>" (peer avatars either side of the arrow), scrollable bubble list (bot-named bubbles, attachments as file chips, system lines for pause/limit), bottom **Close Chat** button, Esc closes. Read-only in v1; the user can only Pause, Resume, Retry, Close. Mobile: full-screen sheet (reuse `ui/sheet.tsx`). Sidebar: the receiver's last-message preview shows "Message from ATLAS: <title>". Settings > Bot: "Allow other bots to message this bot" switch.

## 9. Tests

- **C# unit** (`tests/unit`): `ToolSchema.Validate` for the three tools; depth, cycle, per-task and per-thread counts; rate and chain-budget math; peer-origin policy elevation (ALLOW→ASK for the five classes); name resolution (ambiguous, case, other owner); DLP on title/text/attachment names; idempotency key stability; status transitions.
- **Python unit** (`tests/unit`): worker tool presentation, `RunGuard` repeat on `message_bot`, tool visibility (hidden for single-bot users), prompt framing and injection fence.
- **Integration** (`tests/integration/test_bot_messaging.py`, mock OpenRouter planner extended with a scripted `message_bot` call): A→B→reply round trip and rows in both conversations; Try again after a failed receiver without duplicates; loop A→B→A on a new thread denied; depth 4 denied; ping-pong pause; rate and chain-budget caps; other owner's bot returns 404 with no existence leak; receiver cannot read the sender's file or memory; peer-origin `delete_file` raises an approval card even with policy ALLOW; DLP-blocked send; bot delete closes threads; audit chain still verifies; restart mid-send is exactly-once.
- **E2E (Playwright)** (`tests/e2e/bot-messaging.spec.ts`): row appears in sending → waiting → replied; overlay header text and Close Chat; inline reply bubble; failed state with Try again; paused state with Resume; mobile sheet; keyboard open/close.
- **Regression:** existing suites (policy, security, reliability, chat-polish, refresh-notice) stay green; the new class must not change the default policy page snapshot except for one new row.

## 10. Size estimate (chunks, **est.**)

| # | Chunk | Content | Size |
|---|---|---|---|
| 1 | Schema + threads core | `015` migration, `BotThreads.cs` (create/append/status, limits, name resolution) | M, ~450 LOC + 120 tests |
| 2 | Tools + policy | `ToolSchema`, `Dispatch` cases, `bot_message` class, peer-origin elevation, DLP, `OutboundLog` kind, audit | M, ~350 + 150 tests |
| 3 | Delivery loop | receiver task creation, completion hook → reply, `peer_reply` wake-up, `wait_seconds` park/resume, timeout sweep, SSE | M, ~350 + 150 tests |
| 4 | API routes | peers, threads, retry/pause/resume/close, per-bot switch, attachments copy | S-M, ~300 + 100 tests |
| 5 | Worker | tool offer/presentation, peer prompt frame, mock planner scripts | S, ~150 + 80 tests |
| 6 | Web | `thread` block, row, inline replies, overlay, states, Try again, settings switch | M, ~600 + e2e 150 |
| 7 | Hardening + docs | integration suite, abuse cases, `SECURITY.md` section, `V0_4`/CHANGELOG notes | S, ~100 + 250 tests |

Total about 2,300 LOC including tests **(est.)**, in 7 chunks that fit the existing Codex chunk workflow (`gpt-6-luna`, low effort, at most 2 in parallel). Chunks 1→2→3 are sequential. 4 and 5 can run in parallel after 3. 6 can start after 4. 7 is last.

## 11. Open decisions for Saad

1. First contact between two bots: auto-allow (recommended, all bots are yours) or ask once per pair?
2. Default for waiting: async only (recommended) or let bots wait up to 60 s?
3. Should you be able to type into a bot-to-bot thread from the overlay (read-only in v1)?
4. Cross-user messaging (needs organizations): defer to v0.5 (recommended).
