# Research: the computer screen look, and how agent products build, supervise, test and ship software

Historical research snapshot written 2026-10-23 (PKT) for Saad. Method: web research plus a read of this repo (`src/`) at that time. Later integration work changed the codebase, so repo-state claims and the "what is missing" analysis below are not current status. Every claim is tagged **[confirmed]** (a source or the screenshot says it), **[repo]** (read in the code at the time), or **[guess]** (inference). Effort figures are original estimates, not remaining-work estimates.

---

## Part A. The screenshot: what is it, and how do we reproduce it?

### A1. What the screenshot shows

- **[confirmed from the image]** A dark page. In the middle is a large rounded screen (about 16:10: roughly 806 x 504 in a 1024-wide image). The wallpaper is a dark grey swoosh. The bottom has a small centred dock with no title bar or top bar: the Chrome logo, one unidentified icon (a grey signpost or hub with an orange ribbon), and a dark ">_" terminal icon with a small blue "running" dot. Below the frame is a dark pill with an eye icon and "Watching" in grey, then a white "Take control" button. The top right of the page has four window buttons (collapse, minimise, restore, close).
- **[confirmed from docs]** This is the Grok Bot full-screen computer view. The release notes say "The full-screen computer view opens in Watching until you press Take control", and that the Bot's computer has a 1920 x 1200 screen, up from 1280 x 800. That matches the 16:10 frame. Source: https://x.ai/changelog/bot
- **[confirmed from docs]** The computer is a managed Linux VM, and each user gets a Firecracker microVM. Each Bot gets its own screen on it. Sources: https://cursor.com/docs/grok-bot/security-faq, https://docs.x.ai/grok-bot/computer-and-apps, https://botskills.sh/blog/why-grok-bot-has-no-linux-app
- **[not documented anywhere I could find]** Which desktop environment, window manager or dock it uses. No page I found names it.

### A2. Which OS or desktop does it look like?

- **[guess, medium confidence]** The look is ChromeOS-like: a centred shelf with only icons, a Terminal icon in the ChromeOS style, and a Chrome icon. The ChromeOS shelf centres its icons when they fit (https://chromium.googlesource.com/chromium/src.git/+/refs/heads/main/ash/shelf/). ChromeOS Terminal is the Linux terminal app (https://chromeos.dev/en/linux/setup).
- **[guess]** It is probably not literal ChromeOS or ChromeOS Flex. Docs describe a generic managed Linux VM running a non-root bot process, not ChromeOS, and Flex is an OS for physical devices. The likelier setup is a custom minimal Linux desktop (an X11 server, a light window manager, and a custom or styled dock) themed to look like a shelf. I can't tell you which window manager.
- **[unknown]** The middle icon. I can't identify it from the pixels, so treat it as a custom app (possibly a Files-like or viewer app).
- Don't copy the Chrome or ChromeOS artwork. Use the Chromium icon (open source) or your own icons. Chrome's logo is Google's trademark **[guess, not legal advice]**. This matches Saad's rule of not copying Grok Bot's artwork.

### A3. What our computer image already has **[repo]**

`services/computer/Dockerfile` and `services/computer/desktop/`:
- Debian trixie-slim, Xvfb (default `DISPLAY_GEOMETRY=1024x768`, 16-bit depth), openbox, x11vnc started on demand, tint2, feh, pcmanfm, Chromium, xterm, and s6-overlay.
- Two tint2 panels: a 28 px top bar (navy, clock, "Applications") and a 52 px full-width bottom dock (navy, `disable_transparency = 1`) with Chromium, Files and Terminal launchers. The icons are simple ImageMagick-drawn PNGs.
- A navy SVG wallpaper rendered by rsvg-convert, plus a launch-or-raise script for Chromium.
- The web UI already has a full computer view, with a Take control button and a "Watching live" label (`apps/web/components/computer-pane.tsx`).

So we already have the pieces. The difference is style: no top bar, a floating centred dock, a grey swoosh wallpaper, a 16:10 screen, and nicer icons.

### A4. How to reproduce the look (recommended, in order)

1. **Resolution 1920 x 1200 (16:10).** Set `DISPLAY_GEOMETRY=1920x1200`. The memory cost is small; at 16-bit depth Xvfb needs about 4.6 MB for the framebuffer. The real cost is more pixels to encode over RFB and for screenshots, so check the 4 GB host budget. Keep 1280 x 800 as a low-end option, and always scale in the UI.
2. **Window manager: keep openbox.** It is already lean. Remove the top tint2 bar, hide window decorations on the maximised browser, and set the openbox theme to something flat and dark. `labwc` and an XFCE panel are not needed. labwc is a Wayland compositor, which would mean replacing the whole Xvfb/x11vnc stack **[guess]**, so don't switch.
3. **Dock: tint2, shrunk and floating.** Use one panel: `panel_position = bottom center horizontal`, `panel_shrink = 1`, `panel_size` set to content, `panel_margin` about 0 10, `rounded = 14`, a dark semi-transparent background (`background_color = #1b1b1b 85`), `panel_items = L`, `launcher_icon_size = 40`, `launcher_padding` about 10, and `panel_dock = 1`. Keep `autohide = 0`. Add a running dot with the taskbar active indicator, or use tint2's `T` item with icon only. Docs: https://wiki.archlinux.org/title/Tint2 and https://manpages.debian.org/trixie/tint2/tint2.1.en.html. Transparency needs a compositor, so either:
   - (a) set `disable_transparency = 0` and run `picom` (`backend = "xrender"`, `vsync = false`) with `corner-radius`, with shadows off for docks (https://github.com/yshui/picom/blob/next/picom.sample.conf), or
   - (b) skip the compositor and use an opaque dark dock. This is cheaper in RAM and CPU. **Recommended for 4 GB hosts**: start with (b), and treat (a) as optional and test the cost first.
   `plank` and `cairo-dock` give nicer docks but need a compositor, pull in many libraries, and add RAM per bot **[guess]**. Avoid them.
4. **Wallpaper.** Make a dark grey swoosh (a PNG or SVG made with our own gradients) and set it with `feh --bg-fill`. We already do something like this. Draw our own curve, not Grok Bot's image.
5. **Icons.** Install `papirus-icon-theme` (Debian package; https://packages.debian.org/sid/x11/papirus-icon-theme) and set `launcher_icon_theme = Papirus-Dark` and `launcher_icon_theme_override = 1` in tint2. Or ship our own three PNGs (browser, files, terminal) drawn with our logo style. Own icons are safer for the "don't copy" rule.
6. **Rounded frame in the web UI.** Wrap the RFB canvas in `rounded-2xl overflow-hidden` with a fixed `aspect-ratio: 16 / 10`, scaled to fit the container. noVNC-style scaling is `scaleViewport = true`, `clipViewport = false`. For view-only (watching) set `viewOnly = true`; Take control sets it to false (https://novnc.com/noVNC/docs/API.html). Our bridge may differ; the principle is the same. **[repo]** the UI already has a read-only and a control mode.
7. **The Watching / Take control pill.** A dark pill, `rounded-full border border-white/10 bg-neutral-900 p-1`, below the frame. Left: an eye icon plus "Watching" in grey (status text). Right: a white `rounded-full` button, "Take control". While in control, switch it to "You're in control" with a Stop button (this already exists). Open in Watching by default, as Grok Bot's release notes say. **[repo]** the current label says "Watching live" and the button uses the bot accent; change to match the screenshot (grey text, white button).
8. **Page chrome.** The four buttons top right are page controls (collapse, minimise, restore, close). **[repo]** these already exist per `docs/V0_4.md`.

Rough effort: items 1 to 5 about 1 day including a visual check; items 6 to 7 about 0.5 day. Verify with a Playwright screenshot and a memory check on the smallest host.

---

## Part B. How agent products make, supervise, test and ship software

### B1. Patterns, with sources

| # | Pattern | Who does it (sources) |
|---|---|---|
| 1 | **Isolated VM or container per agent, with a full dev environment.** | Cursor cloud agents run in isolated VMs with a desktop (https://cursor.com/docs/cloud-agent/capabilities, https://cursor.com/blog/agent-computer-use). Codex Cloud gives each task its own isolated workspace from a published environment (https://learn.chatgpt.com/docs/environments/cloud-environments). Devin boots a fresh copy of a snapshot per session (https://docs.devin.ai/onboard-devin/environment/blueprints). OpenHands runs an agent server in a Docker container, which can include VNC and Chromium (https://arxiv.org/pdf/2511.03690). Grok Bot uses a per-user Firecracker microVM. |
| 2 | **Reusable environment setup**: an install script, a start script, and snapshots, so new runs start ready. | Codex: install script plus "start skill"; the setup is tested and published. Cursor: setup scripts and environment snapshots. Devin: blueprints. |
| 3 | **Event-sourced agent loop** (the agent emits typed events: messages, actions, observations; state is replayable; pause and resume). | OpenHands SDK (https://docs.openhands.dev/sdk/arch/conversation): an append-only event log, stuck detection by sliding-window pattern matching, and security review before actions. |
| 4 | **Planner/orchestrator plus workers.** | Anthropic's research system: a lead agent plans and delegates bounded subtasks to parallel subagents, then synthesises. It needs checkpoints, retries and resumable state (https://www.anthropic.com/engineering/multi-agent-research-system). Claude Code subagents run in their own context, can run in the background, can be isolated in a git worktree, and have `maxTurns` and tool limits (https://code.claude.com/docs/en/sub-agents). |
| 5 | **Long tasks across many context windows: a progress file plus git commits.** An initializer session writes `init.sh`, a feature list and a progress file; each later session does one feature, tests it, commits, and updates the progress file (https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents). | Anthropic (also the `claude-quickstarts` autonomous-coding demo). Manus keeps a `todo.md` that it rewrites to keep the goal in context, and treats the sandbox filesystem as external memory (https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus). |
| 6 | **Verify by running the software**: tests, plus driving the app in a browser or desktop, with screenshots, videos and logs as artifacts. | Cursor: agents start dev servers, click through UI flows, record video, and attach artifacts to the PR (blog and capabilities page above). Claude Code hooks run tests deterministically; a Stop hook with exit code 2 stops the agent from finishing until tests pass (https://code.claude.com/docs/en/hooks). Codex: commands for lint and tests go in AGENTS.md; you review the diff and test results. Note: the Codex docs list "Computer and browser use" as not yet supported in cloud environments. |
| 7 | **Ship through a PR, and keep watching CI.** | Cursor opens merge-ready PRs with artifacts. It subscribes to PR and CI events and wakes when they arrive, auto-fixes CI failures, and stops after 10 follow-ups or when a human pushes (capabilities page, sections "Subscriptions" and "Fixing CI Failures"). Claude Code has a GitHub Action (https://code.claude.com/docs/en/best-practices). |
| 8 | **Human approval gates and risk review.** | Grok Bot: approval before irreversible actions, with an independent "Auto Review" model (https://cursor.com/docs/grok-bot/teams). OpenHands: security analysis before an action runs. Claude Code: permission modes and PreToolUse hooks that block commands. |
| 9 | **Take-over.** The human can drive the same desktop and hand it back. | Cursor remote desktop control; Grok Bot "Take control" for passwords, 2FA, CAPTCHA, payments. |
| 10 | **Confidence and progress reporting.** | Devin reports confidence at session start and after planning; the company says green correlates with about twice the merge rate (https://cognition.com/blog/devin-2-1). Grok Bot acknowledges the message before longer work, shows "Waiting on results" for background commands, and a Cursor-hosted bot "keeps working when your laptop is closed" (https://x.ai/changelog/bot). I found no product that publishes a precise time-estimation method. |
| 11 | **Watchdogs for stalls.** | OpenHands stuck detection. Claude Code `maxTurns`. Cursor's CI follow-up cap. Anthropic's checklist: retries, checkpoints and resumable state. **[guess]** Real products also use lease or heartbeat timeouts, which is what our queue already has. |

### B2. What the repo had at the research baseline versus what appeared missing **[repo, 2026-10-23]**

| Pattern | Have | Missing |
|---|---|---|
| Isolated runtime | Per-bot Debian container with Xvfb, openbox, Chromium; per-bot workspace UIDs; TEAMS-ISO network | Hosted isolation tiers (planned in `docs/V0_5_PLAN.md`); environment snapshots or a published "install + start" environment per project |
| Task queue, lease, heartbeat, recovery | `tasks` table with lease, epoch fencing, heartbeat (`worker.py`), `lease_expired` requeue (`Program.cs`), `waiting_*` states, per-owner parallel cap, `WORKER_PARALLEL_TASKS` 4 (max 8) | Progress-based stall detection: a heartbeat shows the worker is alive, not that the task is moving |
| Run budgets | `RunGuard`: repeat limit, 24 steps, **90 seconds** per run (`run_guard.py`) | These budgets are too small for coding work. They need per-task-kind budgets and a "continue in the next run" path |
| Checkpoints | `tasks.checkpoint` column, sent on hold | A progress file in the workspace and git commits per step; resume from them |
| Planner/executor | Model-driven tool loop; mock planner for tests | A visible plan or todo object per task, updated as steps finish (and shown in the UI) |
| Background workers / subagents | Concurrent tasks; `message_bot` / `reply_to_bot`, `create_bot`; approvals relayed across chats; thread rows | Spawning a child task with its own isolated copy of the repo (a git worktree); collecting results with a short summary; parent/child task links |
| Tools for coding | `shell`, `read_file`, `edit_file`, `write_file`, browser tools (`browser_open/click/extract`), `save_artifact`, `setup_env` | Git tools (branch, commit, diff, push); a structured `run_tests` tool with parsed results; desktop computer-use tools (screenshot, click, type) for the bot's own display; log of screenshots as evidence |
| Verification | Grounded answers (`grounding.py`), a large test suite for the product itself | A verification step the bot must pass before it says "done" (a Stop-hook-like gate): tests green plus a UI check with a screenshot or short recording |
| Shipping | None found (no PR tool in `apps/` or `services/`) | PR creation via the GitHub connector with approval; CI watching; auto-fix with a cap |
| Approval gates | PolicyGate, DLP, one-shot approvals, hard-deny rules, injection filter | Approval cards for "push" and "open PR" actions (classes exist for sending messages, not for repo actions) |
| Take-over | Take control with a bot pause lock; Teach a task recording | Nothing important |
| Progress reporting | SSE events; working row with step labels; Platform.Notify | Instant acknowledgement, milestone updates, ETA (see Part C) |
| Stall/loop watchdog | RunGuard repeat limit; lease expiry | OpenHands-style stuck detection over the event stream (same call repeated, no new file changes, alternating errors) |

### B3. Prioritised build plan (effort is a rough estimate for one developer, not measured)

**Tier 1: make long work possible and visible (about 1 week)**
1. Per-task-kind run budgets, and a "continue" path instead of a hard stop at 90 s. Effort 1 day.
2. Progress-based stall watchdog: mark a task `stalled` when no new event for N minutes, and nudge or re-plan once before failing. Effort 1 day.
3. Plan/todo object per task, persisted and shown in the right panel, plus a `progress.md` file in the workspace. Effort 2 days.
4. Instant ack, status labels and completion reply (Part C). Effort 1 day.

**Tier 2: make bots able to build and test code (about 2 weeks)**
5. Git tools and `run_tests` with structured results. Effort 3 days.
6. Verification gate: a task of kind `code` can't be marked done unless the last test run is green, with evidence (command, exit code, counts) attached to the final message. Effort 2 days.
7. Desktop computer-use tools for the bot's own display (screenshot, click, type via xdotool) and screen recording for demo artifacts. Effort 4 days.
8. Child tasks with git-worktree isolation and a short result summary back to the parent. Effort 3 days.

**Tier 3: ship and keep it green (about 1 to 2 weeks)**
9. PR creation through the GitHub connector with an approval card, artifacts in the PR body. Effort 2 days.
10. CI subscription and capped auto-fix (for example max 5 follow-ups; skip if a human pushed). Effort 3 days.
11. ETA from history: store task duration by kind, show p50 to p90 as "usually 5 to 10 min", and say it is an estimate. Effort 1 to 2 days.

**Tier 4: environments (later, with v0.5)**
12. Per-project install and start scripts and snapshots. Effort 1 week or more, tied to `docs/V0_5_PLAN.md`.

**Look-and-feel (independent):** Part A items 1 to 7, about 1.5 days.

---

## Part C. How the parent bot replies and manages tasks

### C1. What Grok Bot says it does **[confirmed from the release notes, https://x.ai/changelog/bot]**
- "Bots acknowledge your message before they start longer work."
- "While a Bot works with nothing to report, a 1:1 chat shows just its animated avatar."
- Bots can wait for a background command, shown as "Waiting on results".
- Work continues in the cloud when the app is closed (https://docs.x.ai/grok-bot/computer-and-apps).
- Bots run in parallel and message each other (https://docs.x.ai/grok-bot/overview).
- I did **not** find official wording for "Working on it" or "Messaging the subagents". Those come from Saad's screenshots and examples, so treat the exact strings as his product copy, not as a documented Grok Bot standard.

### C2. Recommended parent-bot behaviour for AI Teammates
1. **Instant acknowledgement (under 1 second).** When a message will start a task, the API inserts a short assistant message immediately ("On it. I'll check X and report back.") before the worker even leases the task. Use a fixed template or a very cheap call; don't wait for the main model. Skip it for quick chat replies. **[Current repo status, checked 2026-10-25]** The earlier source read missed a partial implementation: after accepting a task, the API publishes `task.started`, and the chat shows an **On it** status chip while waiting for an assistant response. The richer contextual assistant message proposed here is not implemented. See [`MessageAcceptance.cs`](../apps/api/MessageAcceptance.cs), [`chat-pane.tsx`](../apps/web/components/chat-pane.tsx), and the [`speed-phase1` browser test](../tests/e2e/speed-phase1.spec.ts).
2. **Delegate to background workers.** The parent decides: answer now, or create a task (and child tasks or `message_bot` threads for other bots). It never blocks the chat. This matches the existing queue and bot messaging.
3. **Status updates, rate-limited.** Show live state in the working row (below), and post a chat message only at milestones: first plan, blocked on you, approval needed, and every few minutes on long work. Never spam.
4. **Report only verified results.** The final message must be built from evidence the worker recorded (test output, commit hash, URL, artifact, file path), and "done" is only allowed when the verification gate passed. If it didn't pass, say what failed. This extends the existing grounded-answers code (`grounding.py`).
5. **Reply on completion in the original chat**, with a short summary, evidence links and open items, plus a notification if the user left the app (`Platform.Notify`). Failures are reported with the same care as successes.

### C3. The working-row label pattern
**Order of what the row shows** (extends `workingStatus()` in `apps/web/components/shimmer-text.tsx`, **[repo]** which today returns "Typing…" while streaming, else the last status/step, else a tool label, else the task title, else "Working…"):
1. A reply is streaming: **"Typing…"**.
2. A live step label exists: show it, for example "Messaging Scout", "Reading the page", "Running tests".
3. Task started but no step yet: the generic **"Working on it"**, with the bot's animated avatar and the shimmer. Change the fallback so the generic text comes before the task title; show the task title in the panel instead.
4. Blocked states: "Waiting on results" (background command), "Waiting for your approval", "Waiting for you" (take control, login).

**Label rules:**
- A short present-participle phrase, 40 characters at most, sentence case, one trailing "…" at most.
- Built from a fixed map of tool name to label, plus at most one safe target (a bot name or a site's hostname). Never include file contents, URLs with tokens, or secrets. Run labels through DLP.
- Say "Messaging 3 teammates" when steps run in parallel, not three rows.
- Change labels at most about every 800 ms so the text doesn't flicker.
- Worker emits `status` events (the UI already reads `status`, `step`, `tool`); add a label field and keep the tool map as the fallback.
- Under reduced motion, no shimmer; keep the text.

**Sample map to add:** `message_bot` "Messaging {bot}", `reply_to_bot` "Replying to {bot}", `create_bot` "Creating a teammate", `browser_open` "Opening {host}", `browser_click` "Clicking on the page", `browser_extract` "Reading the page", `shell` "Running a command", `run_tests` "Running tests", `edit_file` "Editing {file name}", `save_memory` "Saving a note", and `ask_user` "Waiting for your answer".

Effort: ack plus label map plus fallback order is about 1 day including tests.

---

## Source list
- Grok Bot: https://x.ai/changelog/bot, https://docs.x.ai/grok-bot/computer-and-apps, https://docs.x.ai/grok-bot/overview, https://cursor.com/docs/grok-bot/work, https://cursor.com/docs/grok-bot/security-faq, https://cursor.com/docs/grok-bot/teams, https://botskills.sh/blog/why-grok-bot-has-no-linux-app
- Cursor cloud agents: https://cursor.com/blog/agent-computer-use, https://cursor.com/docs/cloud-agent/capabilities
- Codex cloud: https://learn.chatgpt.com/docs/environments/cloud-environments
- Claude Code: https://code.claude.com/docs/en/sub-agents, https://code.claude.com/docs/en/hooks, https://code.claude.com/docs/en/best-practices
- Anthropic: https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents, https://www.anthropic.com/engineering/multi-agent-research-system, https://github.com/anthropics/claude-quickstarts/tree/main/autonomous-coding
- OpenHands: https://arxiv.org/pdf/2511.03690, https://docs.openhands.dev/sdk/arch/conversation, https://docs.openhands.dev/sdk/guides/agent-server/docker-sandbox
- Devin: https://docs.devin.ai/onboard-devin/environment/blueprints, https://cognition.com/blog/devin-2-1
- Manus: https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- Desktop tools: https://wiki.archlinux.org/title/Tint2, https://manpages.debian.org/trixie/tint2/tint2.1.en.html, https://github.com/yshui/picom/blob/next/picom.sample.conf, https://packages.debian.org/sid/x11/papirus-icon-theme, https://novnc.com/noVNC/docs/API.html, https://chromium.googlesource.com/chromium/src.git/+/refs/heads/main/ash/shelf/, https://chromeos.dev/en/linux/setup
- Caveats: Devin's confidence statistic and Cursor's autofix cap come from vendor pages; Anthropic's "Effective harnesses" is a research write-up, not a spec. The Claude Code Stop-hook and checkpoint details come from search-result summaries of those docs; the sub-agents page I read in full.
