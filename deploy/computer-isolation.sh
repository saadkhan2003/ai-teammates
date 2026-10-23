#!/bin/sh
# Keep bot computers off Postgres, SeaweedFS, the worker, and the API.
# Docker forwards between bridge networks, and the API and agent share
# teammates-computers so they can open a computer's desktop and CDP ports.
# New connections from the computer subnet to private addresses are rejected.
# 172.30.28.10 (API) and 172.30.28.11 (agent) may still dial a computer.
# Computers may open new connections only to the API's port 8080 (egress policy pull, relay tunnel).
# Replies to those dials are ESTABLISHED and are allowed.
set -eu

if iptables-legacy -S DOCKER-USER >/dev/null 2>&1; then
    IPT=iptables-legacy
else
    IPT=iptables
fi

# The guard image and the host checkout use the same pure rule generator.
base=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -f "$base/isolation-guard/rules.py" ]; then
    policy="$base/isolation-guard/rules.py"
else
    policy="$base/rules.py"
fi
exec python3 "$policy" "$IPT"
