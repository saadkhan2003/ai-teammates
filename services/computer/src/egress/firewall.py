"""Per-bot nftables rules for one computer's network namespace.

Bot processes run as distinct unprivileged UIDs (workspace.py, 30000-59999).
Only those UIDs are constrained; root services and the trusted egress proxy
keep working. For a bot UID the output chain is default-deny:

* new connections are allowed only to the egress proxy on 127.0.0.1 (the one exit);
* new loopback connections are allowed only to the bot's own dev-server port
  range, so its localhost servers work and a sibling bot's servers do not;
* replies on flows that those two rules (or a root service) started are allowed;
* everything else (direct internet, DNS, metadata IPs, UDP, ICMP, other
  loopback services such as CDP/VNC/exec) is dropped and counted.

nftables cannot see which UID owns a loopback listener, so cross-bot loopback
separation is by port range: each bot has its own range (DEV_PORT_COUNT ports).
"""
from __future__ import annotations

import shutil
import subprocess

from box_contract import EGRESS_PROXY

TABLE = "bot_egress"
MIN_BOT_UID = 30000
MAX_BOT_UID = 59999
DEV_PORT_BASE = 20000
DEV_PORT_COUNT = 100
DEV_SLOTS = 120  # 20000-31999, below the default ephemeral range (32768+)


def dev_slot(uid: int) -> int:
    return (int(uid) - MIN_BOT_UID) % DEV_SLOTS


def dev_port_range(uid: int) -> tuple[int, int]:
    low = DEV_PORT_BASE + dev_slot(uid) * DEV_PORT_COUNT
    return low, low + DEV_PORT_COUNT - 1


def _check_uid(uid: int) -> int:
    if isinstance(uid, bool) or not isinstance(uid, int) or uid <= 0 or uid > 2**32 - 1:
        raise ValueError("bot UID must be a positive unsigned integer")
    return uid


def render(bot_uids=(), proxy_port: int = EGRESS_PROXY) -> str:
    uids = sorted({_check_uid(uid) for uid in bot_uids})
    elements = " elements = { " + ", ".join(map(str, uids)) + " };" if uids else ""
    per_bot = "".join(
        f"    meta skuid {uid} oifname \"lo\" tcp dport {dev_port_range(uid)[0]}-{dev_port_range(uid)[1]} accept\n"
        for uid in uids
    )
    return f"""table inet {TABLE} {{
  set bot_uids {{ type uid;{elements} }}
  chain output {{
    type filter hook output priority 0; policy accept;
    # Only bot UIDs are constrained; root services and the proxy are untouched.
    meta skuid != @bot_uids accept
    # Replies on flows that a root service or the rules below admitted.
    ct state established,related accept
    # The egress proxy on loopback is the only exit.
    oifname "lo" ip daddr 127.0.0.1 tcp dport {proxy_port} accept
    # Each bot's own localhost dev servers.
{per_bot}    counter drop
  }}
}}
"""


def apply(bot_uids, nft: str | None = None, runner=subprocess.run) -> None:
    """Replace the table atomically (one nft -f transaction). Raises on failure."""
    binary = nft or shutil.which("nft")
    if not binary:
        raise RuntimeError("nft is not installed")
    text = render(bot_uids)
    script = f"table inet {TABLE}\ndelete table inet {TABLE}\n{text}"
    result = runner([binary, "-f", "-"], input=script, text=True, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError("nft apply failed: " + (result.stderr or "").strip()[:300])
