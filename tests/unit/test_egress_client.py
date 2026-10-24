from pathlib import Path
import sys

ROOT = Path(__file__).parents[2]
sys.path.insert(0, str(ROOT / "companion"))
from egress_client import EgressClient, RECONNECT_GRACE_SECONDS, _public_address


def test_client_builds_secure_api_websocket_and_bounds_grace():
    now = [10.0]
    client = EgressClient("https://api.example.test/base", "dev-1", "FAKE_TOKEN_123456789", fail_closed=True, clock=lambda: now[0])
    assert client.server == "wss://api.example.test/base/api/egress/relay/dev-1?role=companion&deviceId=dev-1"
    assert client.route_available()
    now[0] += RECONNECT_GRACE_SECONDS + 0.01
    assert not client.route_available()
    assert client.fail_closed


def test_companion_ssrf_rejects_private_special_and_mapped_addresses():
    for address in ("10.0.0.1", "100.64.0.1", "169.254.169.254", "::1", "fc00::1", "fe80::1", "::ffff:10.0.0.1"):
        assert not _public_address(address)
    assert _public_address("8.8.8.8")
