#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
python3 -m pytest -q "$ROOT/tests/unit/test_isolation_conformance.py" "$ROOT/tests/unit/test_isolation_limits.py" "$ROOT/tests/unit/test_egress_firewall.py" "$ROOT/tests/unit/test_egress_security.py"
