# Cloud UI restoration notes

Historical restoration audit against the supplied `.lost.txt` comparison inputs. Its line-retention counts and file-by-file state apply to that restoration pass; compare against the current source before using them as current acceptance results.

The `.cloud` files are the UI authority. This report accounts for every non-restored exact line in the supplied `.lost.txt` files; reference numbers below are line numbers in that file, not in the source file. Exact-line retention is a textual diagnostic, so helper extraction, added props and token changes count as losses even when the UI is retained.

## Per-file result

| File | Raw added-line retention | Restoration / preserved behavior |
| --- | ---: | --- |
| `apps/web/components/chat-pane.tsx` | 684/754 (90.7%) | Restored cloud content width, empty state, accent bubbles, reply placement, reactions, composer row, voice/send transition, upload cards, job list/live step, seen-ID notices, and expanded tool cards. Kept virtual history/loadUntil, anchored scrolling, StreamDraft, optimistic delivery/retry, ordered composer parts, selection quotes, rich widgets, skills, evidence/plans/budget, peer rows, memory undo/edit/suggestions, prewarm/performance tracking, and test IDs. |
| `apps/web/components/computer-pane.tsx` | 131/143 (91.6%) | Restored cloud fullscreen layout with visible Close, holder/status/pointer lines, power-asleep card, preview/open overlay, caption and control placement. Kept serialized VNC sockets, tab/epoch leases, headless desktop Watch, retries/offline state, multiple-display dots, recording/teaching, minimise/collapse/native fullscreen, Escape, force release, keyboard/zoom, jobs and explicit Continue after human steps. |
| `apps/web/components/workspace.tsx` | 285/309 (92.2%) | Restored cloud header/identity and Details/Library/Computer pane, library subtabs, computer placement and library-event refresh. Kept Lru cache, history paging, frame batching/patchWorkspace, localStorage pane memory/transitions, rich chat callbacks, work-budget/peer settings, sharing, BioField, routines editing, coding/learned sections, teaching and notices. Direct local section links map into Library; routine editing remains available in Library → Routines. |
| `apps/web/components/bot-avatar.tsx` | 10/11 (90.9%) | Restored the exact static cloud GlossyBlob/AvatarEyes/ContactShadow composition and useId/appearance imports. Kept shared-clock animation, shape updates and primary badge. |
| `apps/web/components/approvals.tsx` | 9/9 (100.0%) | Restored cloud card/settled-row typography, uppercase risk line and summary/target/reason markup. Kept all current decision eligibility, relayed approvals, allow-always rules, errors and audit-backed API calls unchanged. |
| `apps/web/components/memory-pane.tsx` | 6/6 (100.0%) | Restored cloud form/list surfaces, labels, save button, loading/error/empty copy, content and timestamp lines. Kept search/filter/types, settings, standing rules, edit/pin/share/forget/undo, suggestions, history, paging and focused-note navigation. Form/list columns now fit available pane width. |
| `apps/web/components/skills-pane.tsx` | 5/5 (100.0%) | Restored cloud replay list, empty/error states and token typography. Kept guide create/edit/archive, source badges, Markdown, bot-edit permission, revisions/revert and replay. |
| `apps/web/components/tasks-pane.tsx` | 9/9 (100.0%) | Restored cloud task empty/error/waiting markup and tokens. Kept AI-neutral connectivity labels and all current task actions. |
| `apps/web/lib/chat-ui.ts` | 171/178 (96.1%) | All cloud UI helpers remain. Kept the newer empty displayModelName implementation to prevent model/provider identities from appearing. |
| `apps/web/lib/message-blocks.ts` | 17/18 (94.4%) | Kept the cloud block types/parsers, with the coding-jobs union terminator restored. Kept richer memory actions/metadata and resume/compacted/resume-card parsing. |
| `apps/web/lib/brand-icon-data.ts` | 1/2 (50.0%) | Kept the existing privacy-filtered catalog. It is identical to the cloud catalog for every non-provider icon; only five provider-logo records remain excluded. No replacement assets or unrelated catalog edits. |

The raw retention command flags only `brand-icon-data.ts` at 50% (one serialized record line out of two added lines). Every non-provider icon matches the cloud catalog exactly. Restoring the five omitted provider entries contradicts the explicit identity-hiding requirement and fails the existing model-privacy test. This exception is intentional, not a weakened test or retention-script change.

## Exact-line exceptions

### `apps/web/components/chat-pane.tsx`

- Reference line(s) 8, 61, 67, 68, 69, 154: Strictly newer composer/send state: one canonical typed reply/quote/text parts model, asTask flag, upload previews, optimistic client IDs and retry payloads replace a second reply state and string-only send path.
- Reference line(s) 20, 21: Strictly newer effect dependencies: preserve conversation resets, stored-history anchoring, virtual-list measurement and streaming-leaf resize following.
- Reference line(s) 33, 80: Strictly newer scrolling: Jump keeps the cloud smooth scroll and adds instant scrolling for reduced-motion users.
- Reference line(s) 35, 36, 37, 38: Strictly newer navigation: jumpTo/loadUntil and the virtual-list reveal handle unloaded originals; highlightPlan respects reduced motion and now also sets the cloud data-highlight attribute.
- Reference line(s) 46, 47: Strictly newer upload transport: use UUID upload IDs and existing /workspace/uploads paths, preserving worker attachment markers.
- Reference line(s) 78, 84: Cloud layout with current accessibility/measurement: keep scroll CSS, overflowAnchor, list refs and log semantics for virtual history.
- Reference line(s) 93, 94, 126: Current shared message helper: MessageItem retains keyboard/touch/menu/delete/retry behavior; renderBubble supplies the cloud bubble/media structure and current IDs.
- Reference line(s) 97, 104, 141, 145, 152, 158, 191: Token/radius mapping: cloud interaction/placement is restored with the requested small control radius rather than pill buttons.
- Reference line(s) 100, 106, 118: Strictly newer rich messages: renderBubble keeps parts/widgets/video analysis/skills/recording attachments, avoids duplicate rich replies/media and retains the measured clamp.
- Reference line(s) 131, 132, 133, 134, 135, 136: Strictly newer streaming: StreamDraft owns draft text/tool updates and de-duplicates completed turns; event filtering also keeps internal model lifecycle notices out of chat. Memory events receive current undo/edit callbacks.
- Reference line(s) 142, 144: Cloud notice with newer compatibility: retain current notice/dismiss test IDs and seen-ID behavior across refreshes.
- Reference line(s) 147, 148: Strictly newer presence: workingStatus retains current task/tool-aware status and avatar fallback in the cloud presence position.
- Reference line(s) 149: Cloud composer with newer layout: preserve safe-area bottom padding, rich parts, drag/drop/paste and current form IDs.
- Reference line(s) 151, 153: Cloud reply chip with strictly newer parts: keep excerpt/image/author, canonical part removal, composer focus and current reply test IDs.
- Reference line(s) 160, 164: Cloud uploads with newer compatibility: retain composer-file/composer-attachments IDs, removal controls and drag/drop/paste.
- Reference line(s) 165, 170, 172, 173, 174, 175, 176, 177, 179, 180, 183, 185: Strictly newer ordered composer: shadcn Textarea and per-part refs support quote/comment segments, drafts, prewarm and Backspace removal. Enter submits only the trailing segment; typing can continue during optimistic delivery.
- Reference line(s) 166, 167, 168: Cloud control with current compatibility: keep composer-plus/plus-* IDs and close-autofocus handling; cloud Add/menu icons and actions remain.
- Reference line(s) 169, 171, 178: Strictly newer teaching: the menu dispatches teammates-teach-task to start recording/control rather than inserting a text prompt.
- Reference line(s) 199: Strictly newer memory UI: focus/blur handlers pause the undo timeout while a user operates the notice.
- Reference line(s) 200: Strictly newer block renderer: resume/compacted/resume_card are handled by their current cards, alongside cloud question/memory/job blocks.
- Reference line(s) 201: Newer user-facing copy: keep the current vault wording without internal model terminology; storage behavior is unchanged.
- Reference line(s) 205: Strictly newer tool labels: toolLabel keeps the current friendly tool names inside the restored cloud collapsible card.

### `apps/web/components/computer-pane.tsx`

- Reference line(s) 1: Newer token mapping: --computer-background is the current desktop background token.
- Reference line(s) 2, 4, 22, 23, 38: Cloud layout with newer behavior: retain exit animation, collapse state, native fullscreen sizing and topbar controls while using the restored full-window structure.
- Reference line(s) 5: Newer close lifecycle: Close exits native fullscreen and hands back an owned lease before calling the workspace exit callback.
- Reference line(s) 27: Newer interaction guard: preserve data-no-expand so Retry/Watch can act without opening fullscreen.
- Reference line(s) 44, 45: Strictly newer human-step feature: attention controls also remain usable fullscreen; explicit Continue is preserved, so the copy does not imply handing back alone resumes work.

### `apps/web/components/workspace.tsx`

- Reference line(s) 1, 35, 36, 43, 44: Privacy override: model selection/display stays outside the user application; current neutral About text and bot settings are retained.
- Reference line(s) 2: Strictly newer loading UI: retain the accessible desktop skeleton instead of a text-only placeholder.
- Reference line(s) 7: Newer Escape handling: keep defaultPrevented/open-dialog checks plus the restored menu guard, so dismissing a menu does not dismiss the pane.
- Reference line(s) 9, 10, 13, 18, 21, 45, 46: Cloud markup with newer state/accessibility: preserve pane transitions, IDs, refresh notices, connection-aware errors and safe-area behavior.
- Reference line(s) 12, 24: Strictly newer avatar behavior: the restored cloud avatar size/placement also keeps animation and primary-badge props.
- Reference line(s) 33, 34: Current token/radius mapping: retain the three cloud tabs, use font-medium and the current small control radius.
- Reference line(s) 37: Strictly newer routines UI: RoutinesSection retains edit-in-chat, status and current actions in the cloud Library tab.
- Reference line(s) 38: Strictly newer skills UI: botId is required for guide CRUD/history in addition to replay.
- Reference line(s) 39: Strictly newer memory UI: focused-note navigation props retain Edit from a chat notice.
- Reference line(s) 40: Privacy-neutral API naming: aiConnected replaces the legacy provider-named connectivity property.
- Reference line(s) 41: Strictly newer teaching behavior: force-mounted desktop stays visible while fullscreen teaching starts from another pane state.
- Reference line(s) 47: Strictly newer settings: preserve work-budget save/error feedback and existing form footer controls.

### `apps/web/components/bot-avatar.tsx`

- Reference line(s) 3: Strictly newer rendering: the static cloud SVG is the non-animated branch of a shared svg value, which also supports the current primary badge and animation.

### `apps/web/components/approvals.tsx`

All supplied lost lines are restored exactly.

### `apps/web/components/memory-pane.tsx`

All supplied lost lines are restored exactly.

### `apps/web/components/skills-pane.tsx`

All supplied lost lines are restored exactly.

### `apps/web/components/tasks-pane.tsx`

All supplied lost lines are restored exactly.

### `apps/web/lib/chat-ui.ts`

- Reference line(s) 1, 2, 3, 4, 5, 6, 7: Privacy override: the newer displayModelName always returns an empty string. Restoring any identity lookup/display logic would violate the user requirement.

### `apps/web/lib/message-blocks.ts`

- Reference line(s) 2: Strictly newer parser: the fenced-block pattern also accepts resume and resume_card. Removing those alternatives would lose current resume UI.

### `apps/web/lib/brand-icon-data.ts`

- Reference line(s) 1: Privacy override: the single serialized catalog line also contains five provider-logo names. The current catalog retains every other cloud entry byte-for-byte and omits only those five; restoring that line fails model-privacy.test.mjs and the user requirement.

## Helper and scope

Workspace and independently rendered panes apply the current `rounded-control` token to descendant buttons, overriding inherited pill defaults without changing shared shadcn components.

`components/message-item.tsx` is the only additional web helper edited: its new optional presentation/renderBubble props are required to compile the restored cloud body composition while preserving current message actions, clamping and rich blocks. No backend, database, worker, computer service, isolation, policy or DLP code changed. No merge/commit/staging, other worktrees, Docker or port 18080 operations were performed.

## Validation

- Required TypeScript no-emit check: passed (zero diagnostics).
- Required JavaScript unit command: 89 passed, 0 failed.
- Avatar-motion tests using the repository TypeScript registration hook: 11 passed, 0 failed.
- Impeccable mechanical design scan: zero findings; git diff --check: passed.
- Additional local Chrome/Playwright smoke harness: 13 checks passed, 0 failed; API calls mocked and external requests blocked; desktop/light/dark/fullscreen/mobile renders inspected. The harness is in `/tmp/ui-restore-browser.mjs` and is separate from the live-stack e2e suite.
- Required retention command: all assigned files at least 90% except the explicitly documented provider-filtered catalog.
- Orchestrator still needs Docker rebuild plus live integration/e2e/VNC verification.
