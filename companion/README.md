# Teammates Companion

The companion is a small Python 3.10+ CLI that pairs a device with Teammates and sends a heartbeat every 30 seconds. It uses only the Python standard library.

Install from this directory with `pipx install .`, or run `python3 teammates_companion.py ...`. On Windows, install Python from python.org and use PowerShell; on macOS and Linux, use the system Python 3.10+ (or `pipx`).

In Teammates, open **Settings → Computer → Add a device**, then pair:

```text
teammates-companion pair --server https://teammates.example --code ABC123
teammates-companion status
teammates-companion run
```

Credentials are stored in `~/.config/teammates-companion/config.json` with mode 600 (use the equivalent config directory on Windows). `run --once` is useful for service managers. To run a command, pass `--command`; `always` executes it, `ask` prompts in the terminal, and `off` refuses. The v0.4 API does not yet provide a remote execution transport, so this option only runs a command locally on the paired device. `unpair` removes local credentials.

For login startup, add `teammates-companion run` to Windows Task Scheduler, a macOS Login Item/LaunchAgent, or a Linux systemd user service.
