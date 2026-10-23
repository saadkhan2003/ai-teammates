# Build worker cut measurements

Run the supervisor with a worker name, its original prompt file, and its worktree:

```bash
bash scripts/cut-supervisor.sh chunk-name /workspace/codex-tools/prompts/chunk-name.md /workspace/ai-teammates-live/src
```

It invokes `/workspace/codex-tools/run_wt.sh` by default. Set `RUNNER` to a compatible executable to use another runner; it receives the same three arguments and can use `CUT_RUN_LOG` and `CUT_LAST_MESSAGE` for its output files. `CUT_LOG` overrides the JSONL destination. `CODEX_LOG_DIR` overrides the runner log directory, `TOOL_CALL_REGEX` overrides the grep-compatible line pattern (default `^exec$`, matching the observed Codex transcript format), and `MAX_RESTARTS` sets the maximum number of relaunches (default 5). Environment values are used as configuration only; the supervisor never prints the environment.

Each completed invocation appends one JSON object containing the worker `name`, monotonic `wall_seconds`, matching-line count `tool_calls`, `exit_code`, `exit_reason` (`completed` or `cut`), and local (`+05:00`) plus UTC start and end timestamps. Completion requires both an existing last-message file and a final `EXIT 0` log line. A cut is relaunched with the original prompt followed by the standard resume instruction. The supervisor exits after completion, the restart limit, or three consecutive fast runs with identical measured durations (under 60 seconds).

Summarize the records with:

```bash
python3 scripts/cut-report.py
python3 scripts/cut-report.py --json
```

The report gives min/median/max wall time, the number in the 3300–3900 second fixed one-hour TTL window, median tool calls, and population coefficients of variation (CV) for both measures. With at least three records, stable wall time (CV < 0.15) and variable tool-call counts (CV >= 0.3) indicate `fixed wall clock`; the reverse pattern indicates `call count`. Other results are `inconclusive`; collect more cuts, especially when fewer than three have been logged. These are signals, not proof of the underlying cause.

## PROGRESS.md convention

Keep `PROGRESS.md` at the worktree root. Use the template in [`PROGRESS_TEMPLATE.md`](PROGRESS_TEMPLATE.md): maintain a checked plan, record the last commit, identify the next step, and link the cut log. Update it after each unit of work and commit that unit so a resumed worker can choose the first unchecked item.
