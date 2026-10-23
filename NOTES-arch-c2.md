# Architecture chunk c2 report

Implemented the row 9 file-transfer security work: request bodies are read with a 100 MiB cap, NUL/oversized path headers are rejected, file content types are sniffed from bytes, and text downloads are blocked by DLP when they contain seeded credential-shaped data. The computer workspace resolver now rejects NUL paths and retains realpath containment checks against symlink escapes.

Files touched: `apps/api/BotFileTransfer.cs`, `apps/api/Routes.cs`, `services/computer/src/workspace.py`, `tests/unit/V03Tests.cs`, `tests/unit/test_workspace.py`, and this report.

Tests added: one C# transfer bounds/sniff/DLP test and one Python NUL/symlink test. Focused checks passed (1 C# test, 2 Python tests). Full unit-suite results are recorded in the final report.

Not implemented: PTY-per-window/tmux reconnect and xterm.js UI. The existing compute provider only exposes bounded exec and JSON control calls; it has no raw bidirectional PTY/WebSocket tunnel or API-to-computer ticket exchange. A ticket issued without that authenticated broker path would not provide user+bot+window binding, so this portion needs a transport/API contract first.

Security notes: file request paths are bounded and NUL rejected; workspace realpath containment blocks traversal and symlink escape; uploads stop once they cross 100 MiB; DLP runs before text file responses. Upload staging still uses bounded in-memory buffering and the existing base64 computer exec transport.
