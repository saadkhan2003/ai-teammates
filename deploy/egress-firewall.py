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


def render() -> str:
    return f"""table inet bot_egress {{
  set bot_uids {{ type uid; }}
  chain output {{
    type filter hook output priority 0; policy drop;
    ct state established,related accept
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
    args = parser.parse_args()
    rules = render()
    if args.apply:
        subprocess.run(["nft", "-f", "-"], input=rules, text=True, check=True)
    else:
        print(rules, end="")


if __name__ == "__main__":
    main()
