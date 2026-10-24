Normal priority, medium effort: Owners can download their task history in stable private JSON pages.

## Goal

Owners can download their task history in stable private JSON pages.

## Context

User said: “Add a private paged export of my task history.” Background: this outcome should remove their current blocker while retaining established behavior.

## References

- [file] `apps/api/Routes.cs` — Follow the existing conventions and boundaries.

## Scope

In:
- apps/api
Out:
- Unrelated components and live infrastructure
Non-goals:
- No unrelated behavior changes.

## Rules

- Maximum page size 100; enforce the existing owner check and redact all secrets.

## Checklist

- Audit success, failure, privacy and unchanged behavior.

## Acceptance criteria

1. Given the requested input, the outcome meets the exact user constraint and preserves existing behavior.

## Verification

1. dotnet test --filter TaskExport; TaskExportPrivacy integration check.

## Assumptions

- Use fixture data and existing authorization.

## Gate

Do not push or merge until every acceptance check passes.

## Report back

Return evidence paths, test pass/fail/skip counts, screenshots when visual, and commit SHA when applicable.
