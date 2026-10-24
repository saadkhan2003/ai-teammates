"""CDP request signing hook for the Web Bot Auth HTTP Message Signatures profile.

The tenant key stays behind the injected signer. This module only sees request URLs
and the resulting short lived headers.
"""
from __future__ import annotations

import base64
import contextvars
import ipaddress
import re
from typing import Awaitable, Callable, Mapping
from urllib.parse import urlsplit

Signer = Callable[[str, str], Awaitable[Mapping[str, str]]]
CURRENT_AUTH_CONFIG: contextvars.ContextVar[Mapping | None] = contextvars.ContextVar("current_web_bot_auth", default=None)


def geo_browser_settings(ip_address: str, geo_lookup: Callable[[str], Mapping[str, str]]) -> dict[str, str]:
    """Resolve exit-IP geo to locale/timezone without coupling tests to a live service."""
    geo = geo_lookup(ip_address)
    country = str(geo.get("country_code") or "").upper()
    locale = str(geo.get("locale") or "")
    timezone = str(geo.get("timezone") or "")
    if len(country) != 2 or not country.isalpha() or not locale or len(locale) > 35 or not timezone or len(timezone) > 64:
        raise ValueError("exit IP geo data is incomplete")
    return {"country": country, "locale": locale, "timezone": timezone}


def fingerprint_browser_settings(country: str, locale: str, user_agent: str | None = None) -> dict[str, str]:
    """Return locale headers alongside native Chromium UA and software WebGL profile hints."""
    if len(country) != 2 or not country.isalpha() or not locale or len(locale) > 35:
        raise ValueError("invalid browser fingerprint locale")
    language = locale.replace("_", "-")
    return {
        "locale": language,
        "acceptLanguage": f"{language},{language.split('-')[0]};q=0.9,en;q=0.7",
        "userAgent": user_agent or "native",
        "webgl": "swiftshader",
    }


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
    def __init__(self, cdp, allowed_hosts=(), signature_agent: str = "", signer: Signer | None = None, *, blocked_hosts=()):
        self.cdp = cdp
        raw_hosts = list(allowed_hosts)
        raw_blocked = list(blocked_hosts)
        if len(raw_hosts) > 500 or len(raw_blocked) > 500:
            raise ValueError("Web Bot Auth allowlist exceeds its size limit")
        self.allowed_hosts = tuple(host for value in raw_hosts if (host := _normalize_host(str(value))) is not None)
        self.blocked_hosts = tuple(host for value in raw_blocked if (host := _normalize_host(str(value))) is not None)
        if signer is not None:
            agent = urlsplit(signature_agent)
            if agent.scheme != "https" or not agent.hostname or agent.username or agent.password or agent.fragment or len(signature_agent) > 512 or any(ord(ch) < 32 or ch in '"\\' for ch in signature_agent):
                raise ValueError("Signature-Agent must be an HTTPS URI")
        self.signature_agent = signature_agent
        self.signer = signer

    def update_config(self, config: Mapping) -> None:
        hosts = list(config.get("allowed_hosts", ()))
        blocked = list(config.get("blocked_hosts", ()))
        if len(hosts) > 500 or len(blocked) > 500:
            raise ValueError("Web Bot Auth allowlist exceeds its size limit")
        agent_value = str(config.get("signature_agent", ""))
        signer = config.get("signer")
        if signer is not None:
            agent = urlsplit(agent_value)
            if agent.scheme != "https" or not agent.hostname or agent.username or agent.password or agent.fragment or len(agent_value) > 512 or any(ord(ch) < 32 or ch in '"\\' for ch in agent_value):
                raise ValueError("Signature-Agent must be an HTTPS URI")
        self.allowed_hosts = tuple(host for value in hosts if (host := _normalize_host(str(value))) is not None)
        self.blocked_hosts = tuple(host for value in blocked if (host := _normalize_host(str(value))) is not None)
        self.signature_agent = agent_value
        self.signer = signer

    async def enable(self) -> None:
        self.cdp.on("Fetch.requestPaused", self._request_paused)
        await self.cdp.send("Fetch.enable", {"patterns": [{"urlPattern": "*", "requestStage": "Request"}]})

    async def _request_paused(self, event: dict) -> None:
        request_id = event.get("requestId")
        request = event.get("request") or {}
        url = str(request.get("url") or "")
        blocked = False
        try:
            parsed = urlsplit(url)
            host = parsed.hostname or ""
            if any(_host_allowed(host, (suffix,)) for suffix in self.blocked_hosts):
                blocked = True
                await self.cdp.send("Fetch.failRequest", {"requestId": request_id, "errorReason": "BlockedByClient"})
                return
            headers = list((request.get("headers") or {}).items())
            if self.signer is not None and parsed.scheme == "https" and parsed.hostname and _host_allowed(parsed.hostname, self.allowed_hosts):
                additions = await self.signer(url, self.signature_agent)
                headers = [(name, value) for name, value in headers if name.lower() not in {key.lower() for key in additions}]
                headers.extend((str(name), str(value)) for name, value in additions.items())
                await self.cdp.send("Fetch.continueRequest", {"requestId": request_id, "headers": [{"name": name, "value": value} for name, value in headers]})
                return
            await self.cdp.send("Fetch.continueRequest", {"requestId": request_id})
        except Exception:
            if blocked:
                return
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
