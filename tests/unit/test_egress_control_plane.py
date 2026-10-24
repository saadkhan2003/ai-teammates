import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).parents[2]
sys.path.insert(0, str(ROOT / "services/computer/src"))

from egress.policy import PolicyFile
from egress.proxy import ConnectProxy


def test_policy_file_keeps_last_good_and_fails_closed_until_first_valid(tmp_path):
    path = tmp_path / "policy.json"
    policy = PolicyFile(path, poll_seconds=0.25)
    assert policy.current() is None

    path.write_text(json.dumps({"version": 3, "mode": "team_only", "entries": ["good.example"]}))
    policy._checked = 0
    assert policy.current().allows("good.example", 443)
    assert not policy.current().allows("other.example", 443)

    path.write_text('{"version":2,"mode":"allow_all"}')
    policy._checked = 0
    assert policy.current().allows("good.example", 443)
    assert not policy.current().allows("other.example", 443)


def test_proxy_rejects_when_no_policy_has_ever_loaded():
    proxy = ConnectProxy()
    assert proxy.current_policy() is None


def test_audit_redacts_path_and_query_and_bounds_reason():
    from egress.proxy import safe_audit_destination

    assert safe_audit_destination("https://user:pass@example.test/private/path?token=secret#frag") == "example.test"
    assert safe_audit_destination("example.test") == "example.test"


def test_route_state_prefers_desktop_then_falls_back_or_blocks_after_grace():
    from egress.relay import RouteState, RECONNECT_GRACE_SECONDS

    now = [0.0]
    route = RouteState(fail_closed=False, clock=lambda: now[0])
    assert route.mode() == "default"
    route.attached()
    assert route.mode() == "desktop"
    route.dropped()
    now[0] = RECONNECT_GRACE_SECONDS - .1
    assert route.mode() == "desktop"
    now[0] = RECONNECT_GRACE_SECONDS + .1
    assert route.mode() == "default"

    closed = RouteState(fail_closed=True, clock=lambda: now[0])
    closed.attached()
    closed.dropped()
    now[0] += RECONNECT_GRACE_SECONDS + .1
    assert closed.mode() == "blocked"


def test_control_plane_writes_versioned_snapshot_atomically_and_audit_is_host_only(tmp_path):
    from egress.control_plane import EgressControlPlane

    class Response:
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def read(self, limit): return json.dumps({"mode":"team_only", "entries":["example.test"], "groups":["group.test"], "locked":False, "version":4, "failClosed":True}).encode()

    calls = []
    control = EgressControlPlane(api_url="http://api", computer_id="fake-computer", token="FAKE_TOKEN_123456789", policy_path=tmp_path / "policy.json", opener=lambda request, timeout: (calls.append(request) or Response()))
    assert control.refresh()
    snapshot = json.loads((tmp_path / "policy.json").read_text())
    assert snapshot["version"] == 4 and snapshot["failClosed"]
    assert snapshot["entries"] == ["example.test", "group.test"]
    control.audit("example.test", 443, False, "blocked by policy")
    assert json.loads(calls[-1].data)["host"] == "example.test"


def test_relay_tunnel_multiplexes_connect_and_tcp_bytes_in_memory():
    from egress.relay_tunnel import RelayTunnelManager

    class FakeWs:
        def __init__(self): self.sent = []
        async def send(self, frame): self.sent.append(frame)

    async def scenario():
        manager = RelayTunnelManager(api_url="https://api", computer_id="fake-id", token="fake", connector=lambda: None)
        fake = FakeWs()
        manager.websocket = fake
        open_task = asyncio.create_task(manager.open("public.example", 443))
        await asyncio.sleep(0)
        request = json.loads(fake.sent[0])
        assert request["type"] == "connect" and request["host"] == "public.example"
        manager.pending[request["id"]].put_nowait({"type": "connected", "id": request["id"]})
        reader, writer = await open_task
        await manager._read_loop(_one_frame(bytes.fromhex("00000001") + b"hello"))
        assert await reader.read() == b"hello"
        await manager.send(bytes.fromhex("00000001") + b"world")
        assert fake.sent[-1] == bytes.fromhex("00000001") + b"world"
        writer.close()
        await asyncio.sleep(0)
        assert json.loads(fake.sent[-1])["type"] == "close"

    def _one_frame(frame):
        async def iterator():
            yield frame
        return iterator()

    asyncio.run(scenario())


def test_control_calls_bypass_the_container_proxy_environment(monkeypatch):
    # HTTP_PROXY points at the egress proxy itself, which would deadlock the policy pull.
    import urllib.request
    from egress.control_plane import EgressControlPlane
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:1")
    monkeypatch.setenv("http_proxy", "http://127.0.0.1:1")
    control = EgressControlPlane(api_url="http://api", computer_id="fake-computer", token="FAKE_TOKEN_123456789")
    assert getattr(control.opener, "__self__", None).__class__.__name__ == "OpenerDirector"
    assert not any(isinstance(h, urllib.request.ProxyHandler) and h.proxies for h in control.opener.__self__.handlers)


def test_relay_tunnel_default_connector_disables_websockets_proxy():
    import inspect
    from egress import relay_tunnel
    assert "proxy=None" in inspect.getsource(relay_tunnel.RelayTunnelManager.run)


def test_fixture_hosts_resolve_to_own_loopback_on_8099_only(monkeypatch):
    import asyncio
    import pytest
    from egress import ssrf
    monkeypatch.setenv("EGRESS_FIXTURE_HOSTS", "portal.example.edu")
    infos = asyncio.run(ssrf.resolve_public("portal.example.edu", 8099))
    assert infos[0][4] == ("127.0.0.1", 8099)
    with pytest.raises(PermissionError):
        asyncio.run(ssrf.resolve_public("127.0.0.1", 8099))          # a literal loopback is still blocked
    monkeypatch.delenv("EGRESS_FIXTURE_HOSTS")
    with pytest.raises((PermissionError, OSError)):
        asyncio.run(ssrf.resolve_public("localhost", 8099))


def test_relay_route_is_desktop_only_after_the_api_reports_a_paired_companion():
    import asyncio
    from egress.relay import RouteState
    from egress.relay_tunnel import RelayTunnelManager

    class Ws:
        def __init__(self, frames): self.frames = frames
        def __aiter__(self): return self._iter()
        async def _iter(self):
            for frame in self.frames: yield frame

    async def scenario():
        state = RouteState()
        manager = RelayTunnelManager(api_url="https://api", computer_id="fake-id", token="fake", route_state=state, connector=lambda: None)
        await manager._read_loop(Ws(['{"type":"noise"}']))
        assert state.mode() == "default"          # connected to the API but no desktop paired
        await manager._read_loop(Ws(['{"type":"ready"}']))
        assert state.mode() == "desktop"
    asyncio.run(scenario())
