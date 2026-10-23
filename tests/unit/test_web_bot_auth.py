from __future__ import annotations

import asyncio
import time
import pytest

from services.agent.web_bot_auth import WebBotAuthHook, _signature_base, apply_geo_settings, geo_browser_settings, verify_signature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat


class FakeCdp:
    def __init__(self):
        self.handlers = {}
        self.commands = []

    async def send(self, method, params=None):
        self.commands.append((method, params or {}))
        return {}

    def on(self, event, handler):
        self.handlers[event] = handler


def test_hook_signs_only_allowed_hosts_and_continues_every_request():
    signed = []

    async def signer(url, signature_agent):
        signed.append(url)
        return {"Signature-Agent": f'"{signature_agent}"', "Signature-Input": "sig1=...", "Signature": "sig1=:ZmFrZQ==:"}

    cdp = FakeCdp()
    hook = WebBotAuthHook(cdp, ["example.test"], "https://bot.example/", signer)
    asyncio.run(hook.enable())
    assert cdp.commands[0][0] == "Fetch.enable"

    async def run():
        await cdp.handlers["Fetch.requestPaused"]({"requestId": "1", "request": {"url": "https://www.example.test/a"}})
        await cdp.handlers["Fetch.requestPaused"]({"requestId": "2", "request": {"url": "https://tracker.invalid/pixel"}})

    asyncio.run(run())
    assert signed == ["https://www.example.test/a"]
    continued = [params for method, params in cdp.commands if method == "Fetch.continueRequest"]
    assert len(continued) == 2
    assert {item["name"] for item in continued[0]["headers"]} >= {"Signature-Agent", "Signature-Input", "Signature"}
    assert "headers" not in continued[1]


def test_exit_ip_geo_maps_country_to_locale_and_timezone():
    settings = geo_browser_settings("198.51.100.10", lambda ip: {"country_code": "DE", "locale": "de-DE", "timezone": "Europe/Berlin"})
    assert settings == {"country": "DE", "locale": "de-DE", "timezone": "Europe/Berlin"}

    cdp = FakeCdp()
    asyncio.run(apply_geo_settings(cdp, settings))
    assert cdp.commands == [
        ("Emulation.setTimezoneOverride", {"timezoneId": "Europe/Berlin"}),
        ("Emulation.setLocaleOverride", {"locale": "de-DE"}),
    ]


def test_verifier_rejects_expired_and_forged_signatures():
    now = int(time.time())
    private = Ed25519PrivateKey.generate()
    public = private.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    key_id = "fake-key"
    headers = {
        "signature-agent": '"https://bot.example/"',
        "signature-input": f'sig1=("@authority" "signature-agent");created={now};expires={now + 90};keyid="{key_id}";tag="web-bot-auth"',
    }
    base = _signature_base("example.test", headers["signature-agent"][1:-1], now, now + 90, key_id)
    headers["signature"] = "sig1=:" + __import__("base64").b64encode(private.sign(base)).decode() + ":"
    assert verify_signature("example.test", headers, {key_id: public}, now=now)
    expired = dict(headers)
    expired["signature-input"] = f'sig1=("@authority" "signature-agent");created={now - 180};expires={now - 1};keyid="{key_id}";tag="web-bot-auth"'
    assert not verify_signature("example.test", expired, {key_id: public}, now=now)
    headers["signature"] = "sig1=:Zm9yZ2Vk:"
    assert not verify_signature("example.test", headers, {key_id: public}, now=now)


def test_hook_replaces_spoofed_signature_headers_only_for_allowlisted_hosts():
    async def signer(url, signature_agent):
        return {"Signature-Agent": '"https://bot.example/"', "Signature-Input": "fresh", "Signature": "sig1=:ZmFrZQ==:"}

    cdp = FakeCdp()
    hook = WebBotAuthHook(cdp, ["example.test"], "https://bot.example/", signer)
    asyncio.run(hook.enable())
    asyncio.run(cdp.handlers["Fetch.requestPaused"]({"requestId": "x", "request": {"url": "https://foo.example.test/", "headers": {"Signature": "spoof", "Authorization": "kept"}}}))
    continued = [p for method, p in cdp.commands if method == "Fetch.continueRequest"][-1]
    assert [h for h in continued["headers"] if h["name"].lower() == "signature"] == [{"name": "Signature", "value": "sig1=:ZmFrZQ==:"}]
    assert {h["name"]: h["value"] for h in continued["headers"]}["Authorization"] == "kept"


def test_hook_rejects_signature_agent_header_injection():
    async def signer(url, signature_agent): return {}
    with pytest.raises(ValueError):
        WebBotAuthHook(FakeCdp(), ["example.test"], 'https://bot.example/"\r\nX-Evil: yes', signer)


def test_normal_worker_browser_cdp_hook_blocks_private_hosts_and_allows_others():
    cdp = FakeCdp()
    hook = WebBotAuthHook(cdp, blocked_hosts=["internal.example"])
    asyncio.run(hook.enable())
    async def run():
        await cdp.handlers["Fetch.requestPaused"]({"requestId": "private", "request": {"url": "https://git.internal.example/"}})
        await cdp.handlers["Fetch.requestPaused"]({"requestId": "public", "request": {"url": "https://example.org/"}})
    asyncio.run(run())
    methods = [(method, params) for method, params in cdp.commands if method in {"Fetch.failRequest", "Fetch.continueRequest"}]
    assert methods == [
        ("Fetch.failRequest", {"requestId": "private", "errorReason": "BlockedByClient"}),
        ("Fetch.continueRequest", {"requestId": "public"}),
    ]


def test_geo_fingerprint_settings_include_coherent_user_agent_and_webgl_flags():
    from services.agent.web_bot_auth import fingerprint_browser_settings
    settings = fingerprint_browser_settings("DE", "de-DE")
    assert settings["locale"] == "de-DE"
    assert settings["acceptLanguage"].startswith("de-DE")
    assert settings["userAgent"] == "native"
    assert settings["webgl"] == "swiftshader"


def test_rfc9421_appendix_b_2_6_ed25519_vector():
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    public = __import__("base64").b64decode("JrQLj5P/89iXES9+vFgrIy29clF9CC/oPPsw3c5D0bs=")
    signature = __import__("base64").b64decode("wqcAqbmYJ2ji2glfAMaRy4gruYYnx2nEFN2HN6jrnDnQCK1u02Gb04v9EDgwUPiu4A0w6vuQv5lIp5WPpBKRCw==")
    base = (
        '"date": Tue, 20 Apr 2021 02:07:55 GMT\n'
        '"@method": POST\n'
        '"@path": /foo\n'
        '"@authority": example.com\n'
        '"content-type": application/json\n'
        '"content-length": 18\n'
        '"@signature-params": ("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"'
    ).encode()
    Ed25519PublicKey.from_public_bytes(public).verify(signature, base)
    with pytest.raises(InvalidSignature):
        Ed25519PublicKey.from_public_bytes(public).verify(signature, base + b"x")
