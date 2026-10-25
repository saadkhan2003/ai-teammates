# Teammates Companion

The companion is a small Python 3.10+ CLI that pairs a device with Teammates and sends a heartbeat every 30 seconds. It uses only the Python standard library.

Install from this directory with `pipx install .`, or run `python3 teammates_companion.py ...`. On Windows, install Python from python.org and use PowerShell; on macOS and Linux, use the system Python 3.10+ (or `pipx`).

In Teammates, open **Settings → Computer → Add a device**, then pair:

```text
teammates-companion pair --server https://teammates.example --code ABC123
teammates-companion status
teammates-companion run
```

To route computer browser and shell traffic through this device, keep the paired
companion online and run `teammates-companion egress-client`. It maintains an
authenticated WSS relay to the API; reconnects are attempted for 90 seconds.
The account's Settings → Policy → Network policy controls whether traffic falls
back to the server route or fails closed after that grace period.

Credentials are stored in `~/.config/teammates-companion/config.json` with mode 600 (use the equivalent config directory on Windows). `run --once` is useful for service managers. To run a command, pass `--command`; `always` executes it, `ask` prompts in the terminal, and `off` refuses. This Python CLI is the currently available pairing/heartbeat/egress client: its `--command` runs locally and does not use the server's device-command WebSocket. The Rust core and Tauri source are in [`apps/companion`](../apps/companion/README.md). They contain server-mediated command-session code, but the declared `companion-cli` target has no source file and the Tauri shell has no pairing UI; the Tauri shell is also uncompiled and release-unverified. `unpair` removes local credentials.

For login startup, add `teammates-companion run` to Windows Task Scheduler, a macOS Login Item/LaunchAgent, or a Linux systemd user service.
