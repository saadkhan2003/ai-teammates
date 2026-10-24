Normal priority, medium effort: The uploaded research PDF is summarized in a report with a page citation for every claim.

## Goal

The uploaded research PDF is summarized in a report with a page citation for every claim.

## Context

User said: “Summarize the uploaded research PDF and cite pages for each claim.” Background: this outcome should remove their current blocker while retaining established behavior.

## References

- [library] `/api/library/fixture-research` — The uploaded PDF is the only source to summarize.

## Scope

In:
- reports
Out:
- Unrelated components and live infrastructure
Non-goals:
- No unrelated behavior changes.

## Rules

- Reference Library items by ID; do not invent page citations.

## Checklist

- Audit success, failure, privacy and unchanged behavior.

## Acceptance criteria

1. Given the requested input, the outcome meets the exact user constraint and preserves existing behavior.

## Verification

1. Inspect /workspace/reports/research.md citation table against the referenced PDF pages.

## Assumptions

- Use fixture data and existing authorization.

## Gate

Do not push or merge until every acceptance check passes.

## Report back

Return evidence paths, test pass/fail/skip counts, screenshots when visual, and commit SHA when applicable.
