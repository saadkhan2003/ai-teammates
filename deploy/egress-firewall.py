#!/usr/bin/env python3
"""Print a fail-closed nftables output policy; apply explicitly with --apply."""
from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONTRACT = json.loads((ROOT / "contracts/box-contract.json").read_text())
PROXY_PORT = CONTRACT["fixedPorts"]["egressProxy"]
PROXY_ADDRESS = "127.0.0.1"


def render(bot_uids=()) -> str:
    uid_values = sorted(set(int(uid) for uid in bot_uids))
    if any(uid <= 0 or uid > 2**32 - 1 for uid in uid_values):
        raise ValueError("bot UID must be a positive unsigned integer")
    elements = " elements = { " + ", ".join(map(str, uid_values)) + " };" if uid_values else ""
    return f"""table inet bot_egress {{
  set bot_uids {{ type uid;{elements} }}
  set egress_proxy_uids {{ type uid; elements = {{ 0 }}; }}
  chain output {{
    type filter hook output priority 0; policy drop;
    # The trusted proxy runs as root; bot UIDs can reach only its loopback listener.
    meta skuid @egress_proxy_uids accept
    ip daddr {PROXY_ADDRESS} tcp dport {PROXY_PORT} accept
    meta skuid @bot_uids oifname "lo" drop
    counter drop
  }}
}}
"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--print", action="store_true", dest="print_rules", help="print rules without applying")
    parser.add_argument("--apply", action="store_true", help="apply rules with nft")
    parser.add_argument("--bot-uid", action="append", type=int, default=[], help="bot UID to isolate; repeat for each bot")
    args = parser.parse_args()
    rules = render(args.bot_uid)
    if args.apply:
        subprocess.run(["nft", "-f", "-"], input=rules, text=True, check=True)
    else:
        print(rules, end="")


if __name__ == "__main__":
    main()
