"""Operator-only paid eval. NEVER run in CI. Every completion is bounded and metered."""
from __future__ import annotations
import argparse
import json
import math
import os
from pathlib import Path
import sys
from urllib.request import Request, urlopen
from judge import judge, RUBRIC

BASE = "https://openrouter.ai/api/v1"


class SpendLimit(RuntimeError):
    pass


class CappedModel:
    def __init__(self, key, model, cap, input_rate, output_rate):
        if not all(math.isfinite(v) for v in (cap, input_rate, output_rate)) or not 0 < cap <= .05 or min(input_rate, output_rate) <= 0:
            raise ValueError("cap must be <= $0.05 and both conservative price ceilings must be positive")
        self.key, self.model, self.cap = key, model, cap
        self.input_rate, self.output_rate = input_rate, output_rate
        self.start_usage = self.usage()
        self.calls = 0
        self.reserved = 0.0

    def request(self, path, payload=None):
        data = None if payload is None else json.dumps(payload).encode()
        req = Request(BASE + path, data=data, headers={"Authorization": "Bearer " + self.key, "Content-Type": "application/json"})
        with urlopen(req, timeout=20) as response:
            return json.load(response)

    def usage(self):
        data = self.request("/key").get("data", {})
        value = data.get("usage")
        if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or value < 0:
            raise SpendLimit("Cannot verify usage; refusing to spend")
        return float(value)

    def complete(self, prompt):
        before = self.usage()  # GET /key immediately before EACH generation or judge call.
        # UTF-8 byte length bounds input tokens; include generous message/protocol overhead.
        max_tokens = 1200
        projected = (len(prompt.encode()) + 2048) * self.input_rate / 1_000_000 + max_tokens * self.output_rate / 1_000_000
        spent = max(before - self.start_usage, self.reserved)  # usage may lag; never release reservations.
        if spent + projected > self.cap:
            raise SpendLimit("Projected call exceeds remaining spend cap")
        self.reserved = spent + projected
        # max_price enforces the conservative pricing ceilings used above at provider routing time.
        payload = {"model": self.model, "messages": [{"role": "user", "content": prompt}], "max_tokens": max_tokens,
                   "temperature": 0, "response_format": {"type": "json_object"},
                   "provider": {"max_price": {"prompt": self.input_rate, "completion": self.output_rate}}}
        try:
            result = self.request("/chat/completions", payload)
            self.calls += 1
        finally:
            after = self.usage()  # GET /key after EVERY attempted call, including failures.
            if after - self.start_usage > self.cap:
                raise SpendLimit("Usage cap reached; no further calls permitted")
        return result["choices"][0]["message"]["content"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-paid", action="store_true")
    parser.add_argument("--cap", type=float, default=.05)
    parser.add_argument("--model", default=os.environ.get("MODEL_QUICK"))
    parser.add_argument("--input-per-million", type=float, required=True, help="Conservative provider price ceiling, USD")
    parser.add_argument("--output-per-million", type=float, required=True)
    parser.add_argument("--out", type=Path, default=Path("evals/out/briefs"))
    args = parser.parse_args()
    if not args.allow_paid or os.environ.get("CI") or os.environ.get("LLM_PROVIDER", "mock") != "openrouter":
        parser.error("operator opt-in and LLM_PROVIDER=openrouter required; forbidden in CI")
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key or not args.model:
        parser.error("OPENROUTER_API_KEY and configured MODEL_QUICK/--model required")
    results = []
    try:
        model = CappedModel(key, args.model, args.cap, args.input_per_million, args.output_per_million)
        for line in Path(__file__).with_name("golden.jsonl").read_text().splitlines():
            case = json.loads(line)
            generated = json.loads(model.complete("Write a structured brief as JSON (goal,kind,context,references,scope,non_goals,rules,checklist,acceptance[{criterion,check}],assumptions,open_questions,gate,report_back). Bugfix needs repro. Ask before blockers. User ask: " + case["ask"]))
            judged = judge(case["ask"], json.dumps(generated, ensure_ascii=False), model.complete)
            results.append({"id": case["id"], "brief": generated, "judgment": judged})
        stop = "completed"
    except SpendLimit:
        stop = "stopped at spend cap or unavailable usage accounting"
    except Exception:
        stop = "stopped on provider/JSON failure; no further calls"
    args.out.mkdir(parents=True, exist_ok=True)
    # Output is model text; apply the worker's existing secret guard before writing artifacts.
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services/agent"))
    from guard import scrub, strip_text
    (args.out / "results.json").write_text(json.dumps(scrub(results), indent=2, ensure_ascii=False) + "\n")
    summary = f"# Brief eval\n\n{stop}. Completed cases: {len(results)}. Cap: ${args.cap:.2f}.\n\n"
    summary += "\n".join(f"- {r['id']}: {'pass' if r['judgment']['passed'] else 'fail'} — {r['judgment']['reason']}" for r in results)
    (args.out / "summary.md").write_text(strip_text(summary) + "\n")
    print(f"{stop}; {len(results)} cases; results saved to {args.out}")


if __name__ == "__main__":
    main()
