#!/usr/bin/env python3
"""Print (default) or apply the per-bot nftables egress rules for ONE computer.

The rules themselves live in services/computer/src/egress/firewall.py, which
the computer API applies inside the computer's own network namespace whenever
a bot UID is created. This helper prints the same rules for review and can
apply them in the current network namespace (for example with
`sudo nsenter -t <container-pid> -n python3 deploy/egress-firewall.py --apply --bot-uid 30001`).
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services/computer/src"))

from egress import firewall  # noqa: E402

render = firewall.render


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--print", action="store_true", dest="print_rules", help="print rules without applying")
    parser.add_argument("--apply", action="store_true", help="apply rules with nft in this network namespace")
    parser.add_argument("--bot-uid", action="append", type=int, default=[], help="bot UID to isolate; repeat for each bot")
    args = parser.parse_args()
    if args.apply:
        firewall.apply(args.bot_uid)
    else:
        print(render(args.bot_uid), end="")


if __name__ == "__main__":
    main()
