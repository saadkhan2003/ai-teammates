# Architecture chunk c2 report

Completed row 9 terminal work alongside the previously completed file-transfer half. Added a per-window asyncio PTY WebSocket service with bounded binary/text framing, resize handling, tmux-backed reconnects, no idle timeout, and a plain-shell fallback. Added owner-only ticket issuance and an authenticated API WebSocket proxy, plus an xterm.js terminal component. The computer image now installs tmux.

Files touched: `apps/api/Routes.cs`, `apps/api/TerminalTickets.cs`, `apps/web/components/Terminal.tsx`, `apps/web/package.json`, `apps/web/package-lock.json`, `services/computer/Dockerfile`, `services/computer/src/server.py`, `services/computer/src/pty.py`, `services/computer/src/tickets.py`, `tests/unit/TerminalTicketsTests.cs`, `tests/unit/test_terminal_tickets.py`, and this report. The earlier file-transfer files remain as previously committed.

Tests: 6 Python terminal/ticket tests and 2 C# issuer tests added. Full Python unit suite: 120 passed. Full C# unit suite: 209 passed. Web TypeScript check passed. The local tmux reconnect test ran and passed.

Security: tickets use HMAC-SHA256 with a per-computer key derived from the `COMPUTER_TOKEN` environment value, a 256-bit CSPRNG nonce, and a 60-second expiry. The PTY atomically consumes SHA-256 ticket hashes under a lock; ticket values travel only in the WebSocket subprotocol. Request and frame sizes are bounded. No live container/API/browser integration was run because Docker is unavailable in this environment.
