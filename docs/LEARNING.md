# Learning from owner approval signals

Bots learn what their owner likes and dislikes from the owner's own feedback. They never learn from untrusted content such as web pages, files, tool output, other bots or third-party chat members.

## Signals (`approval_signals`, db/049)

| kind | signal | source |
|---|---|---|
| positive | reaction | 👍 ❤️ 🎉 etc. on a bot message (apps/api/Reactions.cs) |
| positive | reply / quote | "yes", "perfect", "looks amazing" replying to or quoting a bot message |
| positive | pick / approval | a card option pick, or an approval decision |
| negative / correction | reaction / reply / steer / redo | 👎, corrections, brief steering, redo requests |

Writers are authenticated owner handlers only. The write boundary in `ApprovalSignals.cs` checks the tenant, the conversation, the source role and the provenance. Callers can't supply an origin. Each signal is deduped per bot with `(bot_id, dedupe_key)`. Toggling a reaction off before the bot consumes it leaves no event.

## Next-turn event

On its next turn the worker gets a pending signal as a bracketed, ATLAS-style line. The signal is then marked `consumed_at`.

```
[The user reacted 👍 to your message: "I prepared a brief for the typography pass."]
[The user replied "perfect" to your message: "…"]
[The user picked "Option B" on your question: "…"]
[The user corrected you: "…"]
```

## Learned notes

A bounded background pass makes one short request per signal and creates no tasks or computers. It extracts what the owner agreed or disagreed with into the existing `memories` store, with `learned_kind`:

- `preference`
- `approved_decision`
- `quality_bar`
- `avoid`

Each note also stores `learned_topic`, `signal_ids` and `learned_source`, which holds the source message link.

- **Dedupe and corrections:** a note with the same topic is updated, and a correction supersedes the older note instead of adding a contradictory one.
- **Deletes are permanent:** a deleted note is a tombstone. Replaying the same signals never brings it back.
- **Safety:** credential-like text and unsafe policy instructions are rejected before and after DLP redaction.
- **Cap:** at most 50 active or pending learned notes per bot. Decisions and quality bars are kept ahead of older generic notes.
- **Prompt context:** active learned notes go into the bot's prompt context next to its memory notes. Briefs also get them through auto-context (see BRIEFS.md).

## UI and API

- **Learned list:** the bot's Details panel has a "What I've learned about you" section (`apps/web/components/learned-section.tsx`). It groups notes by kind, shows where each note came from (for example "from your 👍 on …") and lets the owner delete a note.
- **List notes:** `GET /api/bots/{id}/learned`, owner only.
- **Delete a note:** `DELETE /api/bots/{id}/learned/{noteId}`, owner only. Another user gets 404.

## Tests

- **Unit:** `tests/unit/ApprovalSignalsTests.cs` and `tests/unit/test_approval_signals.py`. They cover:
  - classifying reactions and phrases, and ignoring unrelated text
  - rejecting untrusted origins
  - redacting secrets and stripping injected instructions from excerpts
  - the event wording, dedupe and restart
  - making sure untrusted transcript content never becomes an event
  - replacing learned context after a delete or opt-out
- **Integration:** `tests/integration/test_approval_signals.py`, with the mock LLM. An owner reaction becomes a next-turn event and a learned note. A later correction updates the note, and deleting the note works.
- **Playwright:** `tests/e2e/learning.spec.ts` checks that a reaction shows up in the learned list and that the note can be deleted through the confirm dialog. It takes light and dark screenshots.
