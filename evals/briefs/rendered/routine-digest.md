Normal priority, medium effort: A weekday digest arrives at 09:00 in the owner timezone and stays quiet when nothing changed.

## Goal

A weekday digest arrives at 09:00 in the owner timezone and stays quiet when nothing changed.

## Context

User said: “Every weekday at 9am send a concise project digest, quiet when nothing changed.” Background: this outcome should remove their current blocker while retaining established behavior.

## References

- [file] `apps/api/RoutineService.cs` — Follow the existing conventions and boundaries.

## Scope

In:
- routines
Out:
- Unrelated components and live infrastructure
Non-goals:
- No unrelated behavior changes.

## Rules

- Use owner timezone; weekdays 09:00; no message on NOTHING_NEW.

## Checklist

- Audit success, failure, privacy and unchanged behavior.

## Acceptance criteria

1. Given the requested input, the outcome meets the exact user constraint and preserves existing behavior.

## Verification

1. RoutineRuns schedule test and inspect a quiet-run notification count of zero.

## Assumptions

- Use fixture data and existing authorization.

## Gate

Do not push or merge until every acceptance check passes.

## Report back

Return evidence paths, test pass/fail/skip counts, screenshots when visual, and commit SHA when applicable.
