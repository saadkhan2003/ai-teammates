Normal priority, medium effort: Keyboard focus remains visible in both themes without moving existing layouts.

## Goal

Keyboard focus remains visible in both themes without moving existing layouts.

## Context

User said: “Make keyboard focus visible in both themes without changing layouts.” Background: this outcome should remove their current blocker while retaining established behavior.

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

- Focus ring contrast >=3:1; keep existing geometry and small border radii.

## Checklist

- Audit success, failure, privacy and unchanged behavior.

## Acceptance criteria

1. Given the requested input, the outcome meets the exact user constraint and preserves existing behavior.

## Verification

1. Playwright keyboard-navigation snapshots in light and dark; compare focus visibility.

## Assumptions

- Use fixture data and existing authorization.

## Gate

Do not push or merge until every acceptance check passes.

## Report back

Return evidence paths, test pass/fail/skip counts, screenshots when visual, and commit SHA when applicable.
