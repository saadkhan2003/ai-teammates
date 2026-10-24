# Changelog

## v0.4.0

### Added
- Bot-to-bot messaging (same user only): `message_bot`, `reply_to_bot`, `list_bots`, `thread_status`, `create_bot`, `create_routine`, `update_bot` and thread tools. New conversations, bot and routine creation and teammate changes ask the user first. A peer's delete, payment, signing, credential, external-post, message or manage request is forced to ask even when the user's policy allows it.
- Inline "Messaged <bot> <title>" thread rows in both chats, a thread dialog (resume, close), and relayed approval cards that show in both chats. One decision clears them everywhere.
- A bot can set its own bio with `update_bot`. Cloning a bot copies plugin enablement (never secrets). Saved memories record `message:<id>` as their source.
- Per-teammate "Message other teammates" switch and the `bot_message` / `bot_manage` policy classes.
- Migration 015_bot_messaging.
- The composer has one round icon send button (aria-label "Send"). The separate "Assign work" button is gone.
- Full computer view has an exit animation.
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
- Order-dependent tests (`flushed_chain`, `computer_recovering`, `vnc-lifecycle`) bring their own computer up first, so the full suites pass together.
- Computer pane layout on phones (no overlap) and a minimum desktop height on small desktop windows so the live screen is always visible.
- The virtual /workspace path maps to the per-bot directory. DNS goes through TEAMS-ISO, with a regression test.
- Device heartbeats report current execution and traffic permissions.

### Security
- Companion credentials use mode 600 and are never sent in URLs or logs.
- `off` refuses command execution and `ask` requires terminal confirmation.
