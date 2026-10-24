Normal priority, medium effort: The research bot returns a source-linked comparison of the two storage options.

## Goal

The research bot returns a source-linked comparison of the two storage options.

## Context

User said: “Ask the research bot to compare our two storage options with sources.” Background: this outcome should remove their current blocker while retaining established behavior.

## References

- [file] `apps/api/BotMessaging.cs` — Follow the existing conventions and boundaries.

## Scope

In:
- reports
Out:
- Unrelated components and live infrastructure
Non-goals:
- No unrelated behavior changes.

## Rules

- Read-only delegation; no credentials, spending or private notes from another bot.

## Checklist

- Audit success, failure, privacy and unchanged behavior.

## Acceptance criteria

1. Given the requested input, the outcome meets the exact user constraint and preserves existing behavior.

## Verification

1. Inspect source-linked two-option comparison in /workspace/reports/storage.md.

## Assumptions

- Use fixture data and existing authorization.

## Gate

Do not push or merge until every acceptance check passes.

## Report back

Return evidence paths, test pass/fail/skip counts, screenshots when visual, and commit SHA when applicable.
