# Electron shell for the Next.js UI (plan only, not built)

Goal: the main desktop app is the existing Next.js UI in an Electron window, like Grok Bot's desktop app. Server stays in the cloud.

Plan:
1. `apps/desktop/` with `main.ts`, `preload.ts`, electron-builder config. Window loads the hosted web app URL (`TEAMS_APP_URL`, default prod URL); no Node integration in the renderer (`contextIsolation: true`, `sandbox: true`), strict navigation allow-list (own origin only; other links open in the system browser), `setWindowOpenHandler` deny.
2. Session: the same cookie login as the web; no tokens stored by the shell.
3. Preload exposes a tiny typed API: `openCompanion()`, `companionStatus()` (reads the local companion's loopback status endpoint, optional), `appVersion()`. Nothing else.
4. Companion link: Settings → Computer shows the paired device list from `/api/devices`; "Add a device" opens the pairing code and offers to launch the companion tray app by custom URL scheme `teammates-companion://pair?code=...` (code only, never a token).
5. Packaging: electron-builder for Windows (NSIS), macOS (dmg, notarized), Linux (AppImage/deb); auto-update via electron-updater against signed releases. Code-signing certificates are Saad's to buy.
6. Tests: Playwright-Electron smoke (window opens, login page renders, external link goes to browser, preload exposes only the listed functions).
7. Estimate (assumption): 3-4 days for shell and tests, plus 2-3 days for signing/installers.
Open: whether the web UI should hide its own sidebar chrome inside Electron (default no).
