Normal priority, medium effort: The cron parser becomes easier to maintain while accepting exactly the same schedules.

## Goal

The cron parser becomes easier to maintain while accepting exactly the same schedules.

## Context

User said: “Refactor the cron parser without changing accepted schedules.” Background: this outcome should remove their current blocker while retaining established behavior.

## References

- [file] `apps/api/RoutineTime.cs` — Follow the existing conventions and boundaries.

## Scope

In:
- apps/api
Out:
- Unrelated components and live infrastructure
Non-goals:
- No unrelated behavior changes.

## Rules

- Preserve five-field cron and minimum interval 5 minutes.

## Checklist

- Audit success, failure, privacy and unchanged behavior.

## Acceptance criteria

1. Given the requested input, the outcome meets the exact user constraint and preserves existing behavior.

## Verification

1. dotnet test --filter RoutineTime; compare accepted schedule fixture outputs.

## Assumptions

- Use fixture data and existing authorization.

## Gate

Do not push or merge until every acceptance check passes.

## Report back

Return evidence paths, test pass/fail/skip counts, screenshots when visual, and commit SHA when applicable.
