# Teammates

Self-hosted bots that each keep a Linux computer, a visible browser, and a conversation. This is v0.4: managed devices, a companion CLI, and a mock model unless you connect your own OpenRouter key.

A bot can react to a user message with one emoji. The same emoji removes it, and a different emoji replaces it. The pill updates from the conversation event stream. A reaction you add to a bot message is hidden feedback for the bot's next turn. It does not start a task or a reply.

The API is **ASP.NET Core 10 LTS** (`net10.0`). There is no separate computer-manager and no Go process. Compute is an `IComputeProvider` inside the API. `DockerComputeProvider` is the only runtime implementation. It talks to Docker through a restricted socket proxy that user computers cannot reach. `FakeComputeProvider` is for tests. `contracts/proto/compute/v1/compute.proto` is the future ASP.NET↔Go contract. It is checked in and linted. It is not served in this MVP.

## Quick start

```bash
bash scripts/install.sh
sudo docker compose up -d --build
```

## v0.4

v0.4 adds device pairing and permissions in **Settings → Computer**, plus the cross-platform Python companion in [`companion/`](companion/). Upgrade with the normal compose rebuild, create a pairing code in Settings, then run `teammates-companion pair --server URL --code CODE` and `teammates-companion run`. See [`companion/README.md`](companion/README.md) and [`docs/COMPANION.md`](docs/COMPANION.md).

Open [http://127.0.0.1:18080](http://127.0.0.1:18080). Sign in as `saad` / `teammates-dev` (change these in `.env` before any shared host).

`scripts/install.sh` writes a 32-byte master key to `secrets/secrets_master_key`. Compose mounts `deploy/seccomp-chrome.json` into the API. The API inlines that JSON on container create, because the Docker Engine API treats `seccomp=` as a profile document, not a host path. The socket proxy buffer is raised so that document fits.

If containers can resolve each other but connections time out, this host is applying an iptables-legacy `FORWARD DROP` while Docker wrote nft rules. `scripts/install.sh` sets the legacy FORWARD policy to ACCEPT.

## Architecture

```text
browser → Caddy :18080/:18443
            ├─ web (Next.js)
            └─ api (ASP.NET Core 10)  /api, /health, /vnc
                 ├─ SecretBroker + model gateway
                 ├─ policy gate, data checker, login broker
                 ├─ IComputeProvider
                 │    └─ DockerComputeProvider
                 │         └─ docker-socket-proxy → dockerd
                 ├─ postgres (pgvector)
                 └─ SeaweedFS S3
agent (Python) → http://api:8080 on the internal network
user computer (per bot) → Xvfb, Chromium, x11vnc
```

Networks:

- `front` — Caddy, web, API
- `teammates-back` (internal) — API, agent, Postgres, SeaweedFS, mock model
- `teammates-computers` — user computers. The API (`172.30.28.10`) and the agent (`172.30.28.11`) join it so they can open the desktop API, VNC, and CDP. The network has a route to the internet. `deploy/computer-isolation.sh` rejects new connections from every other address on that subnet to private ranges, so a computer cannot open Postgres, SeaweedFS, the worker, or the API. The `isolation` service shares the host network namespace and reinstalls those rules on startup, because a Docker daemon restart clears `DOCKER-USER`. The API checks the same rules at its own startup and before creating, starting, restarting, restoring, or waking a computer. If the rules cannot be installed it logs `computer isolation alert`, marks admin health down, and refuses the start with `computer_isolation_missing`.
- `teammates-dockerctl` (internal) — API and the socket proxy only

User computers are not published on the host. Current Chromium binds DevTools to localhost and rejects a hostname `Host` header, so each computer runs a small proxy on port 9222 that rewrites the header and the websocket URL. The agent attaches there. x11vnc listens on the computer's network interface (view port 5900, control port 6900) so the API can bridge noVNC. Those ports are not mapped to the host. The computer does not get the Docker socket, the master key, the worker token, or S3 credentials.

The object store is SeaweedFS. Official MinIO images were not available from this environment (Docker Hub missing, Quay 401, dl.min.io 410). The S3 API is the same shape: path-style, bucket `artifacts`.

## Environment

Copy `.env.example` to `.env`. Compose interpolates `${VAR}` from that file. It does not load the whole file into the agent or the computers.

There is no `OPENROUTER_API_KEY` variable. Connect the key in Settings → Secrets. The model gateway resolves `secret://openrouter/default`. The bot and the model see the reference, not the key.

`ENABLE_TEST_HOOKS=true` allows `POST /internal/test/users` and the audit-chain check. Set it to `false` on a VPS. Those paths are not on the public proxy. The worker calls `http://api:8080`. Integration tests publish the API on `127.0.0.1:18081` (`API_URL`). `deploy/Caddyfile.test` is the only Caddyfile that proxies `/internal/*` and `/metrics`, and it is not the default. `deploy/Caddyfile.production` is the Let's Encrypt example. See `docs/SECURITY.md`.

`COMPUTE_PROVIDER=docker` is the only accepted runtime. `remote` is reserved for a later Go host.

## Secrets

AES-256-GCM. The master key is 32 bytes in a Docker secret file mounted only on the API. Associated data is `{secretId}|{ownerId}|{type}|{keyVersion}` with lowercase GUID text.

Back up `secrets/secrets_master_key` separately from Postgres. A database dump cannot decrypt secrets without it. `scripts/backup.sh` checks that the dump does not contain the key bytes. `scripts/restore-verify.sh` restores into `agent_restore` and checks that a wrong key fails and the real key works. It does not print plaintext.

## Tests

```bash
make test-unit          # dotnet + planner, guard, and Caddyfile checks, no stack
make test-contract      # fake provider, then DockerComputeProvider
make test-integration   # publishes 127.0.0.1:18081, then acceptance against :18080 and worker calls against API_URL
make test-e2e           # Playwright, system Chrome
make test               # all of the above
```

`make eval-real` is not part of `make test` or CI, and it was not run in this workspace. It exits if `OPENROUTER_API_KEY` is missing. Point `LLM_PROVIDER=openrouter` and `OPENROUTER_BASE_URL=https://openrouter.ai/api/v1`, restart the API, then run it. The script reads the key from the environment only long enough to store it through SecretBroker as `secret://openrouter/default` (create, or rotate if one is already saved). It never prints the key. See [Real-model eval](#real-model-eval).

CI lints the proto (`buf lint`, and `buf breaking` once the proto exists on `main`), and runs unit plus fake contract tests. It does not boot the full stack.

## Test it yourself

Sign in at [http://127.0.0.1:18080](http://127.0.0.1:18080) as `saad` / `teammates-dev`.

1. Open Settings → Secrets. The OpenRouter form is empty until a key is saved. Paste any mock key that starts with `sk-or-` and is at least 20 characters (the bundled mock accepts these). Test connection, then Save securely. The page should say Connected and show only the last four characters.
2. Create a bot from the home page or New bot. The first bot on an account starts that account's computer. Later bots share it. The chat composer stays usable while work runs. Click the bot's name to open the same details pane on every bot.
3. Assign work the mock planner knows, one message at a time:
   - `What should I call you?`
   - `Terminal: write the word pong into /workspace/notes/ping.txt`
   - `Remember that my favorite editor is Helix`
   - `Open http://portal.example.edu:8099/alpha.html and extract the h1`
   - `Create a report artifact named field-notes.txt that says the survey waypoint is north gate.`
   - `Fix the add function in /workspace/sample-repo and run its tests`
   - `Delete the file /workspace/secret.txt` — an approval card appears. Allow once, and the task finishes.
   - `Post this note to the public board: hello from the yard` — the card names `external_post`. Allow once.
   - Send `Please file card 4242424242424242` with the chat button. The data-policy line appears and the message is not stored.
   - `Sign in at the portal` — a masked form shows `portal.example.edu`. Submit, and the card reads Done ✓. The password is not in the reply.
   - `Open the CAPTCHA page http://portal.example.edu:8099/captcha.html and extract the challenge` — the computer shows an attention banner. Take control, Click human check, Resolve attention, Hand back. The pointer returns to view only.
   - `thanks!` — the bot adds a 👍 pill and does not reply. Use the emoji row on a bot message to add, remove, and replace your own reaction. That does not start a task.
4. Open the bot's name, then Computer. The noVNC frame connects on its own. Open pages lists each browser tab. Take control, then Hand back, and confirm the label returns to view only.
5. Files: upload a file into `/workspace`. Download it from the list. Artifacts lists `field-notes.txt`.
6. Memory shows Helix. On a completed task, Save as skill, then Replay on the Skills tab. The replay's model-call count stays at 0.
7. Routines: create one. It runs from the scheduler even if you leave the page. Tests move `nextRunAt` into the past with `PATCH /api/routines/{id}` because the form has no "run now" button.
8. The account button opens Settings. System shows model calls, average planner latency, cost, computer memory, and Chrome process count. Usage shows the per-user report for an owner or admin. General switches Light, Dark, and System. Ctrl/Cmd-K opens the command palette.

To add a portal password the bot can type, use Add secret with namespace `university`, name `password`, type `PASSWORD`, and allowed domain `http://portal.example.edu:8099`. Then assign `Type the stored password into the login form at http://portal.example.edu:8099/login.html using secret://university/password`.

## Real-model eval

`evals/eval_real.py` (`make eval-real`) is the only command that should run against a real OpenRouter model. It is not part of `make test`. Do not run it until you have a key and have restarted the API with `LLM_PROVIDER=openrouter`.

The script stores or rotates `secret://openrouter/default` through the secrets API, creates one bot, and runs three tasks. It prints status, model calls, elapsed time, and cost. It does not print the key.

## Deploying on a 4–8 GB VPS

1. Install Docker Engine and the Compose plugin. Open only TCP 80 and 443 (or the published 18080/18443 if you keep the dev mapping).
2. Run `scripts/install.sh`. Store the master key somewhere that is not the VPS disk you would restore from alone.
3. Edit `.env`: owner password, Postgres password, S3 secret, worker token, computer token, metrics token. Set `ENABLE_TEST_HOOKS=false`.
4. Leave the Chrome seccomp file at `deploy/seccomp-chrome.json`. Compose mounts it into the API.
5. `sudo docker compose up -d --build`. The `isolation` service installs the computer firewall rules and puts them back after a Docker restart. `make up` also runs `deploy/computer-isolation.sh` once. Recreate each existing computer after a network change so it leaves `teammates-back`.
6. Put Caddy, or another proxy, on the public ports. Start from `deploy/Caddyfile.production` (hostname, Let's Encrypt, HSTS, the noVNC CSP, 32 MB bodies). Do not publish `/internal/*` or `/metrics`. Do not publish Postgres, SeaweedFS, CDP, VNC, or the Docker proxy. Login attempts are limited in the API.

Defaults fit a 4 GB / 2 vCPU host. With `MAX_COMPUTERS` unset, the API allows 2 computers when MemTotal is under 6 GiB and 3 on an 8 GB machine. Each computer is capped at 640 MB, 0.40 CPU, and 64 MB of shared memory. `bash scripts/low-end.sh` starts Compose with the `lowend` profile inside a 4 GiB / 2 CPU cgroup and updates a computer that was created on an older quota. The measurement and the verdict are in `docs/PERFORMANCE.md`.

## Limits

- v0.2 invites more people (owner, admin, member) and gives each account one computer. See `docs/V0_2_PLAN.md`. The policy gate, data checker, login card, and closed public proxy are in `docs/SECURITY.md`. An idle computer stops after 10 minutes (`IDLE_POWER=hibernate`) so the host gets the RAM back, and the next task or desktop view starts it again. `reclaim` pauses instead and tries to drop cache; `pause` keeps the old behaviour. Each computer's home and workspace sit on a fixed-size ext4 file. `/tmp` is a 64 MB tmpfs. Email verification, web push, and the Go compute host are not in this build.
- Bots on one account share that account's computer, browser, and disk. Bots created before that record keep their older computers.
- Idempotency keys and delete tombstones live in the API process. A restart reloads computers from Docker labels and forgets those keys.
- The computer control API inside the desktop container runs as root so it can signal s6.
- Login-share bundles from the earlier design notes are not in this MVP.
- Embeddings are a local 64-dimension hash, not a hosted model.
- Skill replay runs the saved steps with zero model calls. It does not re-plan.
- `eval-real` is prepared and was not run. No OpenRouter key was available.
