import sys
import asyncio
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[2] / "services/computer/src"))
import browser_flags
from egress import policy, ssrf
from egress.proxy import ConnectProxy


def test_ssrf_blocks_special_ranges_and_noncanonical_literals():
    for host in ("127.0.0.1", "10.1.2.3", "169.254.169.254", "172.16.0.1", "192.168.1.2", "::1", "fc00::1", "fe80::1", "::ffff:10.0.0.1", "0x7f000001", "0177.0.0.1", "2130706433"):
        assert ssrf.is_blocked_ip(host), host
    assert not ssrf.is_blocked_ip("8.8.8.8")


def test_policy_exact_wildcard_ip_cidr_and_host_port():
    p = policy.NetworkPolicy("team_only", ["example.com", "*.allowed.test", "192.0.2.0/24", "service.test:8443"])
    assert p.allows("example.com", 443)
    assert p.allows("sub.allowed.test", 443)
    assert not p.allows("evilexample.com", 443)
    assert not p.allows("allowed.test", 443)
    assert p.allows("192.0.2.9", 443)
    assert p.allows("service.test", 8443) and not p.allows("service.test", 443)


def test_chrome_dns_and_udp_leak_protections():
    flags = browser_flags.chrome_egress_flags()
    assert "--proxy-server=127.0.0.1:8791" in flags
    assert any(x.startswith("--host-resolver-rules=MAP * ~NOTFOUND") for x in flags)
    assert "--disable-quic" in flags
    assert "--force-webrtc-ip-handling-policy=disable_non_proxied_udp" in flags


def test_proxy_denies_private_destination_and_policy_decision(tmp_path, monkeypatch):
    monkeypatch.setenv("EGRESS_AUDIT_PATH", str(tmp_path / "audit.jsonl"))

    async def request(authority, allow):
        proxy = ConnectProxy(policy.NetworkPolicy("team_only", [authority] if allow else []))
        server = await asyncio.start_server(proxy.handle, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        writer.write(f"CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n\r\n".encode())
        await writer.drain()
        response = await reader.read(4096)
        writer.close()
        await writer.wait_closed()
        server.close()
        await server.wait_closed()
        return response

    blocked = asyncio.run(request("10.0.0.1:443", True))
    assert b"403" in blocked and b"destination address is blocked" in blocked
    denied = asyncio.run(request("example.test:443", False))
    assert b"403" in denied and b"blocked by policy: add example.test" in denied
    audit = (tmp_path / "audit.jsonl").read_text()
    assert '"allowed":false' in audit


def test_plain_http_request_is_forwarded_upstream_not_echoed_to_the_client(tmp_path, monkeypatch):
    import socket
    from egress import proxy as proxy_module
    monkeypatch.setenv("EGRESS_AUDIT_PATH", str(tmp_path / "audit.jsonl"))

    async def run():
        seen = []

        async def upstream(reader, writer):
            seen.append(await reader.readuntil(b"\r\n\r\n"))
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
            await writer.drain()
            writer.close()

        upstream_server = await asyncio.start_server(upstream, "127.0.0.1", 0)
        up_port = upstream_server.sockets[0].getsockname()[1]

        async def fake_resolve(host, port):
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", up_port))]

        monkeypatch.setattr(proxy_module, "resolve_public", fake_resolve)
        authority = f"site.test:{up_port}"
        proxy = ConnectProxy(policy.NetworkPolicy("team_only", [authority]))
        server = await asyncio.start_server(proxy.handle, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        writer.write(f"GET http://{authority}/a.html?q=1 HTTP/1.1\r\nHost: {authority}\r\n\r\n".encode())
        await writer.drain()
        response = await asyncio.wait_for(reader.read(4096), 5)
        writer.close()
        server.close()
        upstream_server.close()
        return response, seen

    response, seen = asyncio.run(run())
    assert response.endswith(b"ok") and b"200 OK" in response
    assert seen and seen[0].startswith(b"GET /a.html?q=1 HTTP/1.1\r\n")
