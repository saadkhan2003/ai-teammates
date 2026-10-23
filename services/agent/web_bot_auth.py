"""CDP request signing hook for the Web Bot Auth HTTP Message Signatures profile.

The tenant key stays behind the injected signer. This module only sees request URLs
and the resulting short lived headers.
"""
from __future__ import annotations

import base64
import ipaddress
import re
from typing import Awaitable, Callable, Mapping
from urllib.parse import urlsplit

Signer = Callable[[str, str], Awaitable[Mapping[str, str]]]


def geo_browser_settings(ip_address: str, geo_lookup: Callable[[str], Mapping[str, str]]) -> dict[str, str]:
    """Resolve exit-IP geo to locale/timezone without coupling tests to a live service."""
    geo = geo_lookup(ip_address)
    country = str(geo.get("country_code") or "").upper()
    locale = str(geo.get("locale") or "")
    timezone = str(geo.get("timezone") or "")
    if len(country) != 2 or not country.isalpha() or not locale or len(locale) > 35 or not timezone or len(timezone) > 64:
        raise ValueError("exit IP geo data is incomplete")
    return {"country": country, "locale": locale, "timezone": timezone}


async def apply_geo_settings(cdp, settings: Mapping[str, str]) -> None:
    await cdp.send("Emulation.setTimezoneOverride", {"timezoneId": settings["timezone"]})
    await cdp.send("Emulation.setLocaleOverride", {"locale": settings["locale"]})


def _host_allowed(host: str, allowlist: tuple[str, ...]) -> bool:
    normalized = host.rstrip(".").lower()
    return any(normalized == suffix or normalized.endswith("." + suffix) for suffix in allowlist)


def _normalize_host(value: str) -> str | None:
    host = value.strip().lower().lstrip(".").rstrip(".")
    if not host or len(host) > 253 or "/" in host or ":" in host or "@" in host or "*" in host:
        return None
    try:
        normalized = host.encode("idna").decode("ascii")
    except UnicodeError:
        return None
    try:
        ipaddress.ip_address(normalized)
        return normalized
    except ValueError:
        labels = normalized.split(".")
        if any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in labels):
            return None
        return normalized


class WebBotAuthHook:
    def __init__(self, cdp, allowed_hosts, signature_agent: str, signer: Signer):
        self.cdp = cdp
        raw_hosts = list(allowed_hosts)
        if len(raw_hosts) > 500:
            raise ValueError("Web Bot Auth allowlist exceeds its size limit")
        self.allowed_hosts = tuple(host for value in raw_hosts if (host := _normalize_host(str(value))) is not None)
        agent = urlsplit(signature_agent)
        if agent.scheme != "https" or not agent.hostname or agent.username or agent.password or agent.fragment or len(signature_agent) > 512:
            raise ValueError("Signature-Agent must be an HTTPS URI")
        self.signature_agent = signature_agent
        self.signer = signer

    async def enable(self) -> None:
        self.cdp.on("Fetch.requestPaused", self._request_paused)
        await self.cdp.send("Fetch.enable", {"patterns": [{"urlPattern": "*", "requestStage": "Request"}]})

    async def _request_paused(self, event: dict) -> None:
        request_id = event.get("requestId")
        request = event.get("request") or {}
        url = str(request.get("url") or "")
        try:
            parsed = urlsplit(url)
            headers = list((request.get("headers") or {}).items())
            if parsed.scheme == "https" and parsed.hostname and _host_allowed(parsed.hostname, self.allowed_hosts):
                additions = await self.signer(url, self.signature_agent)
                headers = [(name, value) for name, value in headers if name.lower() not in {key.lower() for key in additions}]
                headers.extend((str(name), str(value)) for name, value in additions.items())
                await self.cdp.send("Fetch.continueRequest", {"requestId": request_id, "headers": [{"name": name, "value": value} for name, value in headers]})
                return
            await self.cdp.send("Fetch.continueRequest", {"requestId": request_id})
        except Exception:
            # Signing failures fail open to the site's ordinary request; no exception
            # details (which can contain request data) cross the browser boundary.
            await self.cdp.send("Fetch.continueRequest", {"requestId": request_id})


_INPUT = re.compile(r'^sig1=\("@authority" "signature-agent"\);created=(\d+);expires=(\d+);keyid="([A-Za-z0-9_-]{1,128})";tag="web-bot-auth"$')


def _signature_base(authority: str, agent: str, created: int, expires: int, key_id: str) -> bytes:
    params = f'("@authority" "signature-agent");created={created};expires={expires};keyid="{key_id}";tag="web-bot-auth"'
    return f'"@authority": {authority.lower()}\n"signature-agent": {agent}\n"@signature-params": {params}'.encode("utf-8")


def verify_signature(authority: str, headers: Mapping[str, str], keys: Mapping[str, bytes], *, verifier=None, now: int | None = None) -> bool:
    """Verify the bounded profile. `verifier(key, base, signature)` is injectable for tests."""
    if len(headers) > 32:
        return False
    normalized = {str(k).lower(): str(v) for k, v in headers.items()}
    try:
        agent = normalized["signature-agent"]
        if not (agent.startswith('"https://') and agent.endswith('"') and len(agent) <= 512):
            return False
        match = _INPUT.fullmatch(normalized["signature-input"])
        if not match:
            return False
        created, expires, key_id = int(match.group(1)), int(match.group(2)), match.group(3)
        current = int(__import__("time").time()) if now is None else now
        if expires - created > 120 or created > current + 30 or expires < current or created < current - 180:
            return False
        sig_value = normalized["signature"]
        if not sig_value.startswith("sig1=:") or not sig_value.endswith(":") or len(sig_value) > 256:
            return False
        signature = base64.b64decode(sig_value[6:-1], validate=True)
        key = keys.get(key_id)
        if key is None:
            return False
        base = _signature_base(authority, agent[1:-1], created, expires, key_id)
        if verifier is not None:
            return bool(verifier(key, base, signature))
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
        try:
            Ed25519PublicKey.from_public_bytes(key).verify(signature, base)
            return True
        except InvalidSignature:
            return False
    except (KeyError, ValueError, TypeError, UnicodeError):
        return False
