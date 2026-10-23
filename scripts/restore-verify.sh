#!/usr/bin/env bash
# Restore a custom-format dump into agent_restore and check AES-GCM.
# Usage: scripts/restore-verify.sh backups/agent-....dump
set -euo pipefail
cd "$(dirname "$0")/.."
dump="${1:?dump path required}"
sudo docker exec -i teammates-postgres-1 psql -U "${POSTGRES_USER:-agent}" -d postgres -c "DROP DATABASE IF EXISTS agent_restore"
sudo docker exec -i teammates-postgres-1 psql -U "${POSTGRES_USER:-agent}" -d postgres -c "CREATE DATABASE agent_restore"
sudo docker exec -i teammates-postgres-1 pg_restore -U "${POSTGRES_USER:-agent}" -d agent_restore --no-owner < "$dump"
python3 - <<'PY'
import subprocess
from pathlib import Path
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
sql = "SELECT id::text, owner_user_id::text, type, key_version::text, encode(ciphertext,'hex'), encode(nonce,'hex') FROM secrets LIMIT 1"
raw = subprocess.check_output(["sudo","docker","exec","teammates-postgres-1","psql","-U","agent","-d","agent_restore","-tA","-c",sql], text=True).strip()
if not raw:
    raise SystemExit("no secrets in the restored database")
secret_id, owner_id, secret_type, version, cipher_hex, nonce_hex = raw.split("|")
aad = f"{secret_id}|{owner_id}|{secret_type}|{version}".encode()
blob = bytes.fromhex(cipher_hex)
nonce = bytes.fromhex(nonce_hex)
master = Path("secrets/secrets_master_key").read_bytes()
try:
    AESGCM(b"\x22" * 32).decrypt(nonce, blob, aad)
    raise SystemExit("wrong key was accepted")
except Exception as exc:
    if type(exc).__name__ == "SystemExit":
        raise
print("wrong key rejected")
plain = AESGCM(master).decrypt(nonce, blob, aad)
print("real key decrypted", len(plain), "bytes")
del plain
PY
