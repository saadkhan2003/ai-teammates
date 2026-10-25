# Rust companion skeleton

The workspace keeps the headless core as its only default member. From this directory, run:

```sh
cargo test
cargo clippy -p companion-core -- -D warnings
```

The Cargo manifest declares a `companion-cli` binary at `core/src/bin/companion-cli.rs`, but that source file is absent from this tree. The documented `companion-cli pair`, `run`, and `status` commands are therefore not currently buildable. The Rust core includes a pairing client and session implementation, but neither a CLI binary nor the Tauri shell exposes a pairing flow. For the currently usable Python CLI, see [`companion/README.md`](../../companion/README.md).

The Tauri v2 tray shell lives in `src-tauri/`. It is intentionally excluded from `default-members`; compiling it requires the platform webview and tray system libraries (including WebKitGTK on Linux), which are not installed in this environment. The Tauri crate has not been compiled or runtime-verified here. Its current source reads credentials through `FileStore` at the platform config directory's `credentials.json` (mode 0600 on Unix), then opens the command session when credentials exist. The optional `KeyringStore` is not enabled in the Tauri dependency. The approval window uses plain HTML/JavaScript and shows the full command, and the tray can pause, open the configured server's Computer settings, or quit. Set `COMPANION_SERVER` and optionally `COMPANION_LATEST_VERSION` for the tray menu. `icons/generate_icon.py` generates the original placeholder tray PNG.

The Rust layer is a phase-one skeleton. Device permissions, expiry, command approval, output limits, local audit logging, and token transport are implemented in the core; server-side PolicyGate and DLP remain authoritative. File and browser operations, traffic routing, and signed updates are not implemented.
