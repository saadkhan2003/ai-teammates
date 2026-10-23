#!/usr/bin/env python3
"""Tiny stdio MCP server baked into the computer image. No network install."""
import json
import resource
import socket
import sys

TOOLS = [
    {"name": "echo", "description": "Echo text"},
    {"name": "probe", "description": "Report resource caps and whether private network is blocked"},
]


def blocked() -> bool:
    sock = socket.socket()
    sock.settimeout(1.5)
    try:
        sock.connect(("10.0.0.1", 9))
        return False
    except OSError:
        return True
    finally:
        sock.close()


def main() -> None:
    raw = sys.stdin.read() or "{}"
    try:
        req = json.loads(raw)
    except json.JSONDecodeError:
        req = {}
    method = req.get("method")
    params = req.get("params") or {}
    if method == "tools/list":
        result = {"tools": TOOLS}
    elif method == "tools/call":
        name = params.get("name")
        args = params.get("arguments") or {}
        if name == "probe":
            text = json.dumps(
                {
                    "tools": [tool["name"] for tool in TOOLS],
                    "as_bytes": resource.getrlimit(resource.RLIMIT_AS)[0],
                    "nofile": resource.getrlimit(resource.RLIMIT_NOFILE)[0],
                    "internal_blocked": blocked(),
                }
            )
        else:
            text = str(args.get("text") or "ok")
        result = {"content": [{"type": "text", "text": text}]}
    else:
        result = {"ok": False}
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": req.get("id"), "result": result}))


if __name__ == "__main__":
    main()
