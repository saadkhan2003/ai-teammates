# Coding work

Coding tasks receive a run budget of 200 tool steps and 60 minutes by default. A task can override the bot defaults through its budget endpoint; bot defaults are edited through work settings. API values are clamped to 4–1000 steps and 30 seconds–6 hours. A task plan reports the effective budget and observed step/time use.

The progress watchdog uses `STALL_SECONDS` (default 300 seconds). A task without progress receives one nudge through its transcript; after another full idle window it is flagged as blocked and a chat message and notification are sent. New task steps or plan updates clear the blocked flag. Plans are stored per task and mirrored to `/workspace/.progress/task-<id-prefix>.md`.

The agent can use `git_status`, `git_diff`, `git_commit`, and `run_tests`. Git commands use argument arrays, and commits run normal hooks. Test runners are restricted to npm, pytest, dotnet, and make; output is redacted and limited to the last 60 lines. Successful tests satisfy the optional completion gate until a file write invalidates that result. Owners can override the gate, with an audit event.

`create_pr` is classified as an external post and requires the normal user approval. `watch_ci` reads checks through GitHub CLI and reports when it is unavailable. Child tasks use a separate Git worktree; they are not merged automatically. Review and merge explicitly with `git merge task/<id>`.

Duration estimates use completed tasks of the same owner, kind, and instruction-length bucket. They are shown only when at least three samples exist and are historical ranges, not promises.
