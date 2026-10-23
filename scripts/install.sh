#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
mkdir -p secrets
if [[ ! -s secrets/secrets_master_key ]]; then
  openssl rand -out secrets/secrets_master_key 32
fi
chmod 600 secrets/secrets_master_key
sudo mkdir -p /var/lib/teammates
sudo cp deploy/seccomp-chrome.json /var/lib/teammates/seccomp-chrome.json
if [[ ! -f .env ]]; then
  cp .env.example .env
fi
# Some hosts keep a legacy iptables FORWARD DROP that hides Docker's nft rules.
if command -v iptables-legacy >/dev/null 2>&1; then
  sudo iptables-legacy -P FORWARD ACCEPT || true
fi
echo "Master key is secrets/secrets_master_key. Back it up outside the database."
echo "Next: sudo docker compose up -d --build"
# Disable xtrace before handling an optional inherited model key.
set +x
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
  python3 scripts/seed-openrouter.py || true
fi
