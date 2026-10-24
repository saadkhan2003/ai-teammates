Normal priority, medium effort: History queries use a safe forward-only index with measured fixture query performance.

## Goal

History queries use a safe forward-only index with measured fixture query performance.

## Context

User said: “Add a safe forward-only index migration for history queries.” Background: this outcome should remove their current blocker while retaining established behavior.

## References

- [file] `db/001_init.sql` — Follow the existing conventions and boundaries.

## Scope

In:
- db
Out:
- Unrelated components and live infrastructure
Non-goals:
- No unrelated behavior changes.

## Rules

- Forward-only SQL; no deletion of existing data or production operations.

## Checklist

- Audit success, failure, privacy and unchanged behavior.

## Acceptance criteria

1. Given the requested input, the outcome meets the exact user constraint and preserves existing behavior.

## Verification

1. Inspect EXPLAIN output on a fixture database and run the migration twice for idempotence.

## Assumptions

- Use fixture data and existing authorization.

## Gate

Do not push or merge until every acceptance check passes.

## Report back

Return evidence paths, test pass/fail/skip counts, screenshots when visual, and commit SHA when applicable.
