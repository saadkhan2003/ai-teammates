from __future__ import annotations

import ipaddress
import socket


def _numeric_ip(host: str):
    """Parse canonical IPs and legacy inet_aton decimal/octal/hex spellings."""
    try:
        return ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        pass
    try:
        # inet_aton accepts one to four components and decimal/octal/hex numbers.
        packed = socket.inet_aton(host)
        return ipaddress.IPv4Address(packed)
    except (OSError, ValueError):
        return None


def is_blocked_ip(value: str) -> bool:
    ip = _numeric_ip(value)
    if ip is None:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    # is_global excludes private, loopback, link-local, unspecified, multicast,
    # reserved and metadata/link-local addresses, including IPv6 ULA.
    return not ip.is_global


FIXTURE_PORT = 8099


def fixture_hosts() -> frozenset[str]:
    """Dev fixture names the provider maps to this computer's own loopback (/etc/hosts)."""
    import os
    return frozenset(part.strip().lower() for part in os.environ.get("EGRESS_FIXTURE_HOSTS", "").split(",") if part.strip())


async def resolve_public(host: str, port: int) -> list[tuple]:
    # Exact fixture names on the fixture port reach only this container's own loopback server.
    if port == FIXTURE_PORT and host.lower() in fixture_hosts():
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", port))]
    if not host or len(host) > 253 or any(c.isspace() for c in host):
        raise ValueError("invalid host")
    literal = _numeric_ip(host)
    if literal is not None:
        if is_blocked_ip(str(literal)):
            raise PermissionError("destination address is blocked")
        return [(socket.AF_INET6 if literal.version == 6 else socket.AF_INET, socket.SOCK_STREAM, 6, "", (str(literal), port))]
    infos = await __import__("asyncio").get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    if not infos or any(is_blocked_ip(info[4][0]) for info in infos):
        raise PermissionError("destination resolves to a blocked address")
    return infos
