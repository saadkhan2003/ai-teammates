# Companion app design ("Execution on this computer")

Status: Phase 1 design and skeleton. Replaces the Python CLI in `companion/` once the Rust app matches it (the CLI stays until then). Decision source: Saad, desktop-only product; Electron main app, Rust/Tauri tray companion, C#/Python server (Go only for future SaaS/cloud infra).

## 1. Model (copies Grok Bot)
The app keeps ONE outbound WebSocket to the server. The server sends a command; the app asks "Allow this command?" (Ask every time by default); if approved it runs the command and returns output; every decision and run goes in a local audit log. No inbound port is ever opened on the computer.

## 2. Parts
- `apps/companion/core` (Rust crate `companion-core`, no GUI deps): protocol types, pairing client, WS session loop, permission/decision logic, command runner, audit log, credential store, version check. All tests run headless.
- `apps/companion/src-tauri` (Tauri v2 tray shell): tray menu (status, Pause, Manage devices link, Quit), approval window, update banner. Thin: it calls `companion-core` and shows a prompt through a `Prompter` trait.
- Server (C#, `apps/api/DeviceCommands.cs`, migration `037_device_commands.sql`): WS endpoint, command request API, approval/result bookkeeping, audit entries.

## 3. Pairing and registration (existing, v0.4)
Owner clicks Settings → Computer → Add a device → `POST /api/devices/pair` returns a 12-char code (10 min, single use, SHA-256 stored). App calls `POST /api/devices/pair/complete {code,name,os,version}` and receives `{id, deviceToken}` once. Token goes in the OS credential store (Keychain / Credential Manager / Secret Service); headless fallback is a 0600 file. Server keeps only the token hash.

## 4. Per-device permissions (existing columns)
`execution` = `ask` (default) | `always` | `off`; `route_traffic`, `allow_files`, `allow_browser` default false. Changes via `PATCH /api/devices/{id}`. The server returns current permissions on connect and in heartbeats. The app enforces them locally too: it never trusts the server to skip a prompt it should show. `off` refuses everything; `always` skips the prompt but still logs; PolicyGate, DLP and owner authorization stay server-side and are checked before a request is created.

## 5. Protocol (JSON text frames, v1)
Endpoint: `GET /api/devices/{id}/connect` upgraded to WSS, header `Authorization: Bearer <deviceToken>`. Schema: `contracts/companion/protocol.v1.schema.json` with fixtures in `contracts/companion/fixtures/` that both the Rust and C# tests parse.

Device to server: `hello {version, protocol:1}`, `decision {requestId, decision: "approved"|"denied", reason?}`, `result {requestId, exitCode, stdout, stderr, truncated, durationMs, timedOut}`, `pong`.
Server to device: `welcome {permissions, latest, minCompatible}`, `command {requestId, command, cwd?, timeoutSec, expiresAt}`, `cancel {requestId}`, `permissions {...}`, `ping`.

Rules: a `command` carries an expiry (default 120 s); the app refuses expired ones. Output is capped at 64 KiB per stream (`truncated` set). Timeout default 60 s, max 600 s. A result for a request that was not approved, or from the wrong device, is rejected. Reconnect uses exponential backoff 1 s to 60 s; commands in flight at disconnect become `failed` server-side after the 90 s grace.

HTTP (owner session): `POST /api/devices/{id}/commands {command, cwd?, timeoutSec?}` returns 202 `{id,status}` (409 if device is `off` or offline, 400 on bad input); `GET /api/devices/{id}/commands` list; `GET /api/devices/{id}/commands/{rid}` detail; `POST .../{rid}/cancel`.
Status machine: `pending` → `sent` → `approved` | `denied` → `running` → `completed` | `failed`; also `expired`, `cancelled`. Transitions are checked in code (`DeviceCommandState`), not just in SQL.

## 6. Security model
- Outbound only, TLS only (plain `ws://` allowed only for `localhost` in tests). Token never logged or put in a URL.
- Per-device token, hashed server-side, revoked instantly by Manage devices (DELETE drops the WS).
- Command text is shown in full in the prompt; the prompt cannot be pre-dismissed by the server. Prompt times out to "denied".
- Runner: no shell interpolation by the app beyond the user-approved string; runs as the logged-in user, never elevated; working dir must be absolute and exist; env scrubbed of the app's own secrets; timeout and output cap enforced; process tree killed on timeout.
- Audit: local append-only JSON lines (`audit.log`: time, requestId, command hash + text, decision, exit code, duration), plus server audit-chain entries (`device.command_requested/decided/finished`). Output text is not put in the server audit chain.
- Server never sends commands to a device whose owner session was not the requester; agent-dispatched commands (later) must pass PolicyGate first.
- Version: `GET /api/devices/version`; banner "A new version is available" when below `latest`; execution stops below `minCompatible`.
- Not in phase 1: file and browser access, signed auto-update, agent dispatch wiring.

## 7. Later phases
Phase 2: wire worker/agent tool `run_on_my_computer` to requests with PolicyGate; file and browser permissions; signed installers and auto-update. Phase 3: route traffic through this computer (WSS CONNECT splice per `docs/BOT_COMPUTER_ARCHITECTURE.md` item 8, `fail_closed`, SSRF guard); Manage devices UI polish; Electron shell integration.

## 8. Estimate (planning assumptions, not measured)
Phase 1 skeleton + server + tests: 3-4 days. Phase 2: 5-6 days. Phase 3 (egress): 4-5 days. Signed installers on three OSes: 3-4 days plus certificates (cost not estimated here).
