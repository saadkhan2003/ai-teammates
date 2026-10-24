Normal priority, medium effort: Cancelling an upload clears the busy state and permits exactly one successful retry.

## Goal

Cancelling an upload clears the busy state and permits exactly one successful retry.

## Context

User said: “Retry keeps spinning after cancelling an upload. Keep limits unchanged.” Background: this outcome should remove their current blocker while retaining established behavior.

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

- Preserve the 25 MB upload limit, authorization and DLP.

## Checklist

- Audit success, failure, privacy and unchanged behavior.

## Acceptance criteria

1. Given the requested input, the outcome meets the exact user constraint and preserves existing behavior.

## Verification

1. Playwright upload-cancel-retry spec; screenshot showing cleared busy state.

Reproduction:
- steps: Open the affected flow; Trigger the reported interruption; Retry the operation
- current: The operation loses state or remains busy.
- expected: Retry restores state and completes once.
- unchanged: Permissions, DLP, limits and unrelated flows.

## Assumptions

- Use fixture data and existing authorization.

## Gate

Do not push or merge until every acceptance check passes.

## Report back

Return evidence paths, test pass/fail/skip counts, screenshots when visual, and commit SHA when applicable.
