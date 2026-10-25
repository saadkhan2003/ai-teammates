# Chunk 7 — Create New Bot
> Historical handoff for `Chunk 7 — Create New Bot`. Status, implementation details, test results, and open items below describe that workstream's recorded checkpoint; verify the current source and guides before treating them as current.


Implemented the Create New Bot modal with the original blob avatar picker (15 SVG shapes and 11 colour swatches), a live preview, required name, optional advanced role/instructions, Enter submission, and stable test IDs. Existing test IDs remain supported.

Added `BotAvatar` and deterministic per-bot default selection. It is used in the sidebar, selected bot card, chat header, command palette, quick switcher, and avatar picker/settings. Bot settings now allow changing shape and colour.

Added forward-only migration `014_avatar.sql`; registered and copied it into the API image. Bot create, patch, list, workspace/get responses now accept or return `avatarShape` and `avatarColor`, with allow-list/hex validation.

Verification run:
- `npx tsc --noEmit`: passed.
- `npm run build`: passed.
- `dotnet build apps/api/Teammates.Api.csproj`: passed, 0 warnings/errors.
- `dotnet test tests/unit/Teammates.UnitTests.csproj`: passed, 162 tests.

Added/updated Playwright coverage but did not run Playwright, as requested. Docker rebuild and live integration/e2e verification remain for the orchestrator.
