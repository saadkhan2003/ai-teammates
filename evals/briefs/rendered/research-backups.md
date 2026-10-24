Normal priority, medium effort: Produce a sourced decision report comparing three backup options for a 4 GB host.

## Goal

Produce a sourced decision report comparing three backup options for a 4 GB host.

## Context

User said: “Compare three reliable backup options for a 4 GB server and write a sourced report.” Background: this outcome should remove their current blocker while retaining established behavior.

## References

- [file] `docs/SECURITY.md` — Follow the existing conventions and boundaries.

## Scope

In:
- docs
Out:
- Unrelated components and live infrastructure
Non-goals:
- No unrelated behavior changes.

## Rules

- Use primary sources and access dates; no purchases or deployments.

## Checklist

- Audit success, failure, privacy and unchanged behavior.

## Acceptance criteria

1. Given the requested input, the outcome meets the exact user constraint and preserves existing behavior.

## Verification

1. Inspect /workspace/reports/backups.md source table and compare all three restore procedures.

## Assumptions

- Use fixture data and existing authorization.

## Gate

Do not push or merge until every acceptance check passes.

## Report back

Return evidence paths, test pass/fail/skip counts, screenshots when visual, and commit SHA when applicable.
