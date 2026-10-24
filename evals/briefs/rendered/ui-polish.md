High priority, medium effort: Make chat and Library text match the reference stroke weight in light and dark themes.

## Goal

Make chat and Library text match the reference stroke weight in light and dark themes.

## Context

User said: “Saad: I am frustrated. The text looks heavy. Match /workspace/uploads/2026-10-24/ref.png and notes 36/41, light and dark.” Background: this outcome should remove their current blocker while retaining established behavior.

## References

- [file] `apps/web/components/chat-pane.tsx` — Follow the existing conventions and boundaries.
- [screenshot] `/workspace/uploads/2026-10-24/ref.png` — Match stroke weight at equal zoom.
- [note] `/workspace/ui-handoff/SAAD_UI_NOTES.md` — Notes 36 and 41 contain exact type values.

## Scope

In:
- apps/web
Out:
- Unrelated components and live infrastructure
Non-goals:
- No unrelated behavior changes.

## Rules

- Inter variable body 380–400; labels 450–500; headings <=600; dark primary #e7e9ea.

## Checklist

- Audit success, failure, privacy and unchanged behavior.

## Acceptance criteria

1. Given the requested input, the outcome meets the exact user constraint and preserves existing behavior.

## Verification

1. Playwright typography snapshot and light+dark side-by-side screenshot crops.

## Assumptions

- Use fixture data and existing authorization.

## Gate

Do not push or merge until every acceptance check passes.

## Report back

Return evidence paths, test pass/fail/skip counts, screenshots when visual, and commit SHA when applicable.
