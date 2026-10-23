#!/usr/bin/env bash
set -uo pipefail

usage() { echo "Usage: $0 <name> <prompt-file> <worktree>" >&2; exit 2; }
[[ $# == 3 ]] || usage
name=$1; prompt_file=$2; worktree=$3
[[ -r "$prompt_file" ]] || { echo "Prompt file is not readable" >&2; exit 2; }
[[ -d "$worktree" ]] || { echo "Worktree does not exist" >&2; exit 2; }

runner=${RUNNER:-/workspace/codex-tools/run_wt.sh}
cut_log=${CUT_LOG:-/workspace/ai-teammates-live/wt-logs/cuts.jsonl}
log_dir=${CODEX_LOG_DIR:-/workspace/codex-tools/logs}
tool_regex=${TOOL_CALL_REGEX:-'^exec$'}
max_restarts=${MAX_RESTARTS:-5}
[[ $max_restarts =~ ^[0-9]+$ ]] || { echo "MAX_RESTARTS must be a nonnegative integer" >&2; exit 2; }
mkdir -p "$(dirname "$cut_log")" "$log_dir"
resume_prompt=$(mktemp)
trap 'rm -f "$resume_prompt"' EXIT
current_prompt=$prompt_file
restart_count=0; fast_duration=; fast_repeats=0

while :; do
  run_log="$log_dir/$name.log"; last_message="$log_dir/$name.last.md"
  rm -f "$last_message"
  start_iso=$(TZ=Asia/Karachi date --iso-8601=seconds)
  start_utc=$(date -u --iso-8601=seconds)
  start_ns=$(python3 -c 'import time; print(time.monotonic_ns())')
  if [[ -n ${RUNNER:-} ]]; then
    CUT_RUN_LOG="$run_log" CUT_LAST_MESSAGE="$last_message" "$runner" "$name" "$current_prompt" "$worktree" >"$run_log" 2>&1
    runner_status=$?
  else
    "$runner" "$name" "$current_prompt" "$worktree"
    runner_status=$?
  fi
  end_ns=$(python3 -c 'import time; print(time.monotonic_ns())')
  end_iso=$(TZ=Asia/Karachi date --iso-8601=seconds)
  end_utc=$(date -u --iso-8601=seconds)
  wall_seconds=$(python3 -c 'import sys; print(round((int(sys.argv[2])-int(sys.argv[1]))/1_000_000_000, 3))' "$start_ns" "$end_ns")
  tool_calls=$(grep -Ec -- "$tool_regex" "$run_log" 2>/dev/null || true)
  exit_code=$runner_status
  if [[ -f "$run_log" ]] && tail -n 1 "$run_log" | grep -Eq '^EXIT [0-9]+$'; then exit_code=$(tail -n 1 "$run_log" | awk '{print $2}'); fi
  exit_reason=cut
  if [[ -f "$last_message" && -f "$run_log" ]] && tail -n 1 "$run_log" | grep -qx 'EXIT 0'; then exit_reason=completed; fi

  python3 - "$cut_log" "$name" "$wall_seconds" "$tool_calls" "$exit_code" "$exit_reason" "$start_iso" "$end_iso" "$start_utc" "$end_utc" <<'PY'
import json, sys
path, name, wall, calls, code, reason, start, end, start_utc, end_utc = sys.argv[1:]
record = {"name": name, "wall_seconds": float(wall), "tool_calls": int(calls),
          "exit_code": int(code), "exit_reason": reason, "start_time": start,
          "end_time": end, "start_time_utc": start_utc, "end_time_utc": end_utc}
with open(path, "a", encoding="utf-8") as log:
    log.write(json.dumps(record, separators=(",", ":")) + "\n")
PY
  [[ $exit_reason == completed ]] && exit 0

  if python3 -c 'import sys; raise SystemExit(0 if float(sys.argv[1]) < 60 else 1)' "$wall_seconds"; then
    if [[ $fast_duration == "$wall_seconds" ]]; then fast_repeats=$((fast_repeats + 1)); else fast_duration=$wall_seconds; fast_repeats=1; fi
    (( fast_repeats >= 3 )) && exit "$exit_code"
  else
    fast_duration=; fast_repeats=0
  fi
  (( restart_count >= max_restarts )) && exit "$exit_code"
  restart_count=$((restart_count + 1))
  { cat "$prompt_file"; printf '\n\nResume: read PROGRESS.md and git log -5, check git status, continue with the first unchecked item. Do not restart finished items.\n'; } > "$resume_prompt"
  current_prompt=$resume_prompt
done
