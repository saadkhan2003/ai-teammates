Normal priority, medium effort: Owners can inspect and remove deduplicated lessons private to each bot.

## Goal

Owners can inspect and remove deduplicated lessons private to each bot.

## Context

User said: “Add owner-only deduplicated lessons that can be removed.” Background: this outcome should remove their current blocker while retaining established behavior.

## References

- [file] `apps/api/BriefRoutes.cs` — Follow the existing conventions and boundaries.

## Scope

In:
- apps/api
Out:
- Unrelated components and live infrastructure
Non-goals:
- No unrelated behavior changes.

## Rules

- Normalize whitespace and case per bot; other owners must receive 403.

## Checklist

- Audit success, failure, privacy and unchanged behavior.

## Acceptance criteria

1. Given the requested input, the outcome meets the exact user constraint and preserves existing behavior.

## Verification

1. dotnet test --filter BriefDatabaseTests; inspect dedupe and 403 assertions.

## Assumptions

- Use fixture data and existing authorization.

## Gate

Do not push or merge until every acceptance check passes.

## Report back

Return evidence paths, test pass/fail/skip counts, screenshots when visual, and commit SHA when applicable.
