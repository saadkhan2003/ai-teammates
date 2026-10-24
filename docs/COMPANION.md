# Companion API (v0.4)

Use your HTTPS Teammates base URL in production. Pair from Settings → Computer → Add a device, then enter the displayed code in the companion app/CLI. Update the companion to the release reported by `GET /api/devices/version`. Current latest and minimum compatible versions are `0.4.0`. This release provides registration and permissions; execution transport is not yet connected to the worker.

## Registration

Owner session cookie authentication is required for management. Admins and members cannot manage devices. A device belongs to the pairing owner's account.

- `POST /api/devices/pair` (no body) returns `{code, expiresAt}`. `POST /api/devices` is an alias. Codes are single-use, case-insensitive, valid for ten minutes, and stored as SHA-256 hashes. Expired codes cannot register.
- `POST /api/devices/pair/complete` is companion-facing without a session. JSON: `{code, name, os, version}`. Returns `{id, deviceToken}` once. Store the device token in an OS credential store, never in logs or a URL. Only its SHA-256 hash is retained by the server. Defaults: execution `ask`; route traffic, files, and browser all false. Completion consumes the code and inserts the device atomically. Invalid/reused/expired code: 400.
- Pair creation and completion are independently limited to 30 attempts per ten minutes per source address (creation also scoped to owner); excess returns 429. Limits reset on API restart. Deploy behind the trusted proxy and use an outer proxy limit if durable cross-restart limiting is needed.

## Management and heartbeat

- `GET /api/devices` returns an array of `{id,name,os,version,execution,routeTraffic,allowFiles,allowBrowser,lastSeen,online}`. No hashes or credentials are returned. Online means seen in the past 90 seconds.
- `PATCH /api/devices/{id}` accepts any subset of `{name,execution,routeTraffic,allowFiles,allowBrowser}`. Execution is `ask`, `always`, or `off`. Other values return 400. Missing/foreign IDs return 404. Name limit 120 characters, OS 80, version 40.
- `DELETE /api/devices/{id}` revokes immediately and returns 204. All future heartbeats with the old token fail.
- `POST /api/devices/{id}/heartbeat` requires `Authorization: Bearer <deviceToken>` and JSON `{version}`. Send every 30 seconds. Returns the current public device record and permissions, or 401 for missing/invalid/revoked credentials. Respect returned permissions immediately.
- `GET /api/devices/version` is public and returns `{latest,minCompatible,docs}`. Compare semantic versions in the companion; stop execution if below `minCompatible` and direct the owner to update.

Management returns 403 without an owner session. Pairing, permission updates and revocations create audit-chain entries without codes or tokens. Heartbeats update last-seen without adding high-volume audit entries.

## Execution contract

`DeviceGate` is registered in API dependency injection. `await gate.CanExecute(deviceId)` returns false for missing/revoked devices, unknown modes, or execution `off`. `ask` means the caller must still obtain an approval; `always` does not bypass PolicyGate, DLP, account/workspace authorization or network isolation. Check ownership before the gate and recheck immediately before dispatch. Route traffic, file access, and browser access require their separate flags. This helper is intentionally not wired to agent dispatch in v0.4.

## v0.5 execution transport

The companion keeps one outbound WebSocket at `GET /api/devices/{id}/connect`, authenticated with its paired device bearer token. The server validates each v1 JSON frame (maximum 256 KiB), sends the current permission set and version compatibility, and accepts command decisions and bounded results only for commands belonging to that connected device. The owner session can request, list, inspect, or cancel commands at `/api/devices/{id}/commands`. Requests expire after 120 seconds when they have not been acted on. Output is stored with the command result and omitted from audit entries; audit records contain request identifiers and execution metadata only.

Command execution is available only when the device permission is `ask` or `always` and the device is connected. A device in `off` mode or an offline device returns 409. Command text is limited to 4,000 characters, working directories must be absolute paths or null, and timeout values are clamped to 1–600 seconds (default 60). A disconnect fails in-flight work after the 90-second reconnect grace. Revocation closes a connection when the next frame is handled; the v0.4 device deletion handler has not yet been wired to close the socket immediately.

The migration is `db/037_device_commands.sql`. The API migration runner in `Platform.MigrateAndSeed` includes migration 037 in the merged v0.4 manifest.
