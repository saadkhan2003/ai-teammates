#!/usr/bin/env python3
"""Summarize cut-supervisor JSONL measurements."""
import argparse
import json
import statistics
from pathlib import Path


def coefficient_of_variation(values):
    if not values:
        return None
    mean = statistics.mean(values)
    if mean == 0:
        return 0.0
    return statistics.pstdev(values) / mean


def build_report(records):
    walls = [float(row["wall_seconds"]) for row in records]
    calls = [float(row["tool_calls"]) for row in records]
    wall_cv = coefficient_of_variation(walls)
    calls_cv = coefficient_of_variation(calls)
    if len(records) >= 3 and wall_cv < 0.15 and calls_cv is not None and calls_cv >= 0.3:
        verdict = "fixed wall clock"
    elif len(records) >= 3 and calls_cv is not None and calls_cv < 0.15 and wall_cv >= 0.3:
        verdict = "call count"
    else:
        additional = 3 - len(records) if len(records) < 3 else 3
        verdict = f"inconclusive (need {additional} more cuts)"
    return {
        "count": len(walls),
        "min_wall_seconds": min(walls) if walls else None,
        "median_wall_seconds": statistics.median(walls) if walls else None,
        "max_wall_seconds": max(walls) if walls else None,
        "hour_signal_count": sum(3300 <= value <= 3900 for value in walls),
        "median_tool_calls": statistics.median(calls) if calls else None,
        "wall_seconds_cv": wall_cv,
        "tool_calls_cv": calls_cv,
        "verdict": verdict,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", nargs="?", default="/workspace/ai-teammates-live/wt-logs/cuts.jsonl")
    parser.add_argument("--json", action="store_true", dest="as_json", help="print the report as JSON")
    args = parser.parse_args()
    rows = []
    try:
        with Path(args.path).open(encoding="utf-8") as source:
            for line_number, line in enumerate(source, 1):
                if line.strip():
                    try:
                        rows.append(json.loads(line))
                    except json.JSONDecodeError as exc:
                        parser.error(f"invalid JSON on line {line_number}: {exc}")
    except OSError as exc:
        parser.error(str(exc))
    report = build_report(rows)
    if args.as_json:
        print(json.dumps(report, sort_keys=True))
    else:
        print(f"count: {report['count']}")
        print(f"wall_seconds min/median/max: {report['min_wall_seconds']} / {report['median_wall_seconds']} / {report['max_wall_seconds']}")
        print(f"fixed one-hour TTL signal (3300–3900s): {report['hour_signal_count']}")
        print(f"median tool_calls: {report['median_tool_calls']}")
        print(f"CV wall_seconds/tool_calls: {report['wall_seconds_cv']} / {report['tool_calls_cv']}")
        print(report["verdict"])


if __name__ == "__main__":
    main()
