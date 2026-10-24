Normal priority, small effort: The empty-state label has the correct spelling while typography and layout remain unchanged.

## Goal

The empty-state label has the correct spelling while typography and layout remain unchanged.

## Context

User said: “Correct the misspelled empty-state label and show me a screenshot.” Background: this outcome should remove their current blocker while retaining established behavior.

## References

- [file] `apps/web/components/chat-pane.tsx` — Follow the existing conventions and boundaries.

## Scope

In:
- apps/web
Out:
- Unrelated components and live infrastructure
Non-goals:
- No unrelated behavior changes.

## Rules

- Change only the empty-state spelling; keep body font weight 400.

## Checklist

- Audit success, failure, privacy and unchanged behavior.

## Acceptance criteria

1. Given the requested input, the outcome meets the exact user constraint and preserves existing behavior.

## Verification

1. Playwright empty-state snapshot and screenshot comparison at the same viewport.

## Assumptions

- Use fixture data and existing authorization.

## Gate

Do not push or merge until every acceptance check passes.

## Report back

Return evidence paths, test pass/fail/skip counts, screenshots when visual, and commit SHA when applicable.
