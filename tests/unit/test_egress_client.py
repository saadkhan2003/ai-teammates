from pathlib import Path
import sys

ROOT = Path(__file__).parents[2]
sys.path.insert(0, str(ROOT / "companion"))
from egress_client import EgressClient, RECONNECT_GRACE_SECONDS


def test_client_builds_secure_api_websocket_and_bounds_grace():
    now = [10.0]
    client = EgressClient("https://api.example.test/base", "dev-1", "FAKE_TOKEN_123456789", fail_closed=True, clock=lambda: now[0])
    assert client.server == "wss://api.example.test/base/api/egress/relay/dev-1?role=companion&deviceId=dev-1"
    assert client.route_available()
    now[0] += RECONNECT_GRACE_SECONDS + 0.01
    assert not client.route_available()
    assert client.fail_closed
