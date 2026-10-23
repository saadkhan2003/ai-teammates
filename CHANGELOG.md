# Changelog

## v0.4.0

### Added
- Grok Bot-style dark shell: sidebar of teammates, chat header, right panel (Overview, Computer, Routines, Files/Media), account menu, Settings modal (Settings > Computer, Vault) and keyboard shortcuts.
- Create New Bot dialog: live avatar preview, "Name your Bot" (name only is enough), 15 original SVG avatar shapes, 11 colours. Shape and colour are stored on the bot (migration 014) and used in the sidebar, chat header and bot panel.
- Grounded answers, readable errors for failed tasks, and waiting_resource tasks that resume once the OpenRouter key is saved.
- Empty-key banner linking to Settings > Vault. The installer seeds OPENROUTER_API_KEY once without logging it.
- Node and uv in the computer image, a second display per bot, and auto-retry for purchases and plugin writes.
- Migrations 011_devices, 012_reliability, 013_feedback, 014_avatar.
- Playwright e2e helpers (login, auto-allow browser opens) and specs for the new UI.
- Companion CLI for pairing, status, and heartbeats.
- Settings → Computer device registration and permissions.

### Changed
- Web app and API identify this release as v0.4.

### Fixed
- Computer pane layout on phones (no overlap) and a minimum desktop height on small desktop windows so the live screen is always visible.
- The virtual /workspace path maps to the per-bot directory. DNS goes through TEAMS-ISO, with a regression test.
- Device heartbeats report current execution and traffic permissions.

### Security
- Companion credentials use mode 600 and are never sent in URLs or logs.
- `off` refuses command execution and `ask` requires terminal confirmation.
