#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
STACK="${STACK:?STACK is required}"
mkdir -p backups
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="backups/agent-${stamp}.dump"
sudo -n docker exec "${STACK}-postgres-1" pg_dump -U "${POSTGRES_USER:-agent}" -d "${POSTGRES_DB:-agent}" -Fc > "$out"
if cmp -s secrets/secrets_master_key <(dd if="$out" bs=32 count=1 2>/dev/null); then
  echo "refusing to keep a dump that starts with the master key" >&2
  exit 1
fi
python3 - <<PY
from pathlib import Path
dump = Path("$out").read_bytes()
key = Path("secrets/secrets_master_key").read_bytes()
if key in dump:
    raise SystemExit("master key bytes were found in the database dump")
print("dump ok", "$out", "bytes", len(dump))
PY
echo "The master key is NOT in this dump. Keep secrets/secrets_master_key in a separate backup."
