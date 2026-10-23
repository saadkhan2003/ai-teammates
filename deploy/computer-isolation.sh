#!/bin/sh
# Keep bot computers off Postgres, SeaweedFS, the worker, and the API.
# Docker forwards between bridge networks, and the API and agent share
# teammates-computers so they can open a computer's desktop and CDP ports.
# New connections from the computer subnet to private addresses are rejected.
# 172.30.28.10 (API) and 172.30.28.11 (agent) may still dial a computer.
# Replies to those dials are ESTABLISHED and are allowed.
set -eu

if iptables-legacy -S DOCKER-USER >/dev/null 2>&1; then
    IPT=iptables-legacy
else
    IPT=iptables
fi

"$IPT" -N TEAMS-ISO 2>/dev/null || true
"$IPT" -F TEAMS-ISO
if ! "$IPT" -C DOCKER-USER -j TEAMS-ISO 2>/dev/null; then
    "$IPT" -I DOCKER-USER 1 -j TEAMS-ISO
fi

"$IPT" -A TEAMS-ISO -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
"$IPT" -A TEAMS-ISO -s 172.30.28.10/32 -j RETURN
"$IPT" -A TEAMS-ISO -s 172.30.28.11/32 -j RETURN
for dest in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16; do
    "$IPT" -A TEAMS-ISO -s 172.30.28.0/24 -d "$dest" -p tcp -j REJECT --reject-with tcp-reset
    "$IPT" -A TEAMS-ISO -s 172.30.28.0/24 -d "$dest" -p udp -j DROP
done
"$IPT" -A TEAMS-ISO -j RETURN
