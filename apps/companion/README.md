# Rust companion skeleton

The workspace keeps the headless core as its only default member. From this directory, run:

```sh
cargo test
cargo clippy -p companion-core -- -D warnings
```

`companion-cli pair --server URL --code CODE --name NAME` pairs and stores the returned device credential in the user's config directory (`~/.config/teammates-companion/credentials.json`, mode 0600 on Unix). `companion-cli run` opens the outbound device WebSocket and asks in the terminal before commands. `companion-cli status` reports whether local pairing credentials exist.

The Tauri v2 tray shell lives in `src-tauri/`. It is intentionally excluded from `default-members`; compiling it requires the platform webview and tray system libraries (including WebKitGTK on Linux), which are not installed in this environment. The Tauri crate has not been compiled or runtime-verified here. The approval window uses plain HTML/JavaScript and shows the full command, and the tray can pause, open the configured server's Computer settings, or quit. Set `COMPANION_SERVER` and optionally `COMPANION_LATEST_VERSION` for the tray menu. `icons/generate_icon.py` generates the original placeholder tray PNG.

The Rust layer is a phase-one skeleton. Device permissions, expiry, command approval, output limits, local audit logging, and token transport are implemented in the core; server-side PolicyGate and DLP remain authoritative. File and browser operations, traffic routing, and signed updates are not implemented.
