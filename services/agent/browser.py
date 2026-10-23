"""One Playwright connection per CDP endpoint. The connect lock does not cover waits."""
from __future__ import annotations

import asyncio
from typing import Mapping

try:
    from .web_bot_auth import CURRENT_AUTH_CONFIG, WebBotAuthHook, apply_geo_settings
except ImportError:  # worker executes this module as a top-level script package
    from web_bot_auth import CURRENT_AUTH_CONFIG, WebBotAuthHook, apply_geo_settings

ATTENTION_PHRASES = (
    "please complete the captcha",
    "verify you are human",
    "multi-factor authentication",
    "enter the one-time code",
    "mfa required",
)


def attention_of(text: str) -> str | None:
    lowered = (text or "").lower()
    for phrase in ATTENTION_PHRASES:
        if phrase in lowered:
            return phrase
    return None


class BrowserHub:
    def __init__(self, web_bot_auth: Mapping | None = None) -> None:
        self._playwright = None
        self._playwright_lock = asyncio.Lock()
        self._browsers: dict = {}
        self._connect_locks: dict[str, asyncio.Lock] = {}
        self._guard = asyncio.Lock()
        self._pages: dict[str, dict[str, object]] = {}
        self._last: dict[str, str] = {}
        self._web_bot_auth = web_bot_auth
        self._auth_hooks: dict[int, WebBotAuthHook] = {}

    async def aclose(self) -> None:
        for browser in list(self._browsers.values()):
            try:
                await browser.close()
            except Exception:
                pass
        self._browsers.clear()
        self._auth_hooks.clear()
        if self._playwright is not None:
            await self._playwright.stop()
            self._playwright = None

    async def _lock(self, cdp_url: str) -> asyncio.Lock:
        async with self._guard:
            lock = self._connect_locks.get(cdp_url)
            if lock is None:
                lock = asyncio.Lock()
                self._connect_locks[cdp_url] = lock
            return lock

    async def _ensure_playwright(self):
        if self._playwright is not None:
            return self._playwright
        async with self._playwright_lock:
            if self._playwright is None:
                from playwright.async_api import async_playwright
                self._playwright = await async_playwright().start()
            return self._playwright

    async def connect(self, cdp_url: str):
        lock = await self._lock(cdp_url)
        async with lock:
            existing = self._browsers.get(cdp_url)
            connected = False
            if existing is not None:
                try:
                    connected = bool(existing.is_connected())
                except Exception:
                    connected = False
            if connected:
                return existing
            self._pages.pop(cdp_url, None)
            self._last.pop(cdp_url, None)
            playwright = await self._ensure_playwright()
            last: Exception | None = None
            browser = None
            for _ in range(15):
                try:
                    browser = await playwright.chromium.connect_over_cdp(cdp_url)
                    last = None
                    break
                except Exception as exc:
                    last = exc
                    await asyncio.sleep(1)
            if browser is None:
                raise last or RuntimeError("cdp unavailable")
            self._browsers[cdp_url] = browser
            return browser

    def last_target(self, cdp_url: str) -> str | None:
        return self._last.get(cdp_url)

    async def browser_open(self, cdp_url: str, args: dict) -> dict:
        url = str(args.get("url") or "")
        wait = args.get("wait")
        if not url:
            return _empty("missing_url")
        browser = await self.connect(cdp_url)
        context = browser.contexts[0] if browser.contexts else await browser.new_context()
        page = await context.new_page()
        await self._install_web_bot_auth(page)
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=20000)
        except Exception:
            await page.close()
            raise
        if wait:
            try:
                await page.wait_for_selector(str(wait), state="visible", timeout=12000)
            except Exception:
                pass
        target_id = await _target_id(context, page)
        self._remember(cdp_url, target_id, page)
        return await self._snapshot(page, target_id, attention=False)

    async def _install_web_bot_auth(self, page) -> None:
        config = CURRENT_AUTH_CONFIG.get() or self._web_bot_auth
        if not config:
            return
        existing = self._auth_hooks.get(id(page))
        if existing is not None:
            existing.update_config(config)
            return
        session = await page.context.new_cdp_session(page)
        if config.get("geo_settings"):
            await apply_geo_settings(session, config["geo_settings"])
            await session.send("Network.setExtraHTTPHeaders", {"headers": {"Accept-Language": config.get("accept_language", "en")}})
            user_agent = config.get("user_agent")
            if user_agent and user_agent != "native":
                await session.send("Network.setUserAgentOverride", {"userAgent": user_agent, "acceptLanguage": config.get("accept_language", "en")})
        hook = WebBotAuthHook(session, config.get("allowed_hosts", ()), config.get("signature_agent", ""), config.get("signer"), blocked_hosts=config.get("blocked_hosts", ()))
        await hook.enable()
        self._auth_hooks[id(page)] = hook

    async def browser_extract(self, cdp_url: str, args: dict) -> dict:
        page, target_id = await self._resolve(cdp_url, _target(args))
        selector = str(args.get("selector") or "body")
        try:
            text = await page.locator(selector).first.inner_text(timeout=5000)
        except Exception:
            text = await _body_text(page)
        body = await _body_text(page)
        return {
            "targetId": target_id,
            "url": page.url,
            "title": await page.title(),
            "text": (text or "")[:8000],
            "attention": attention_of(body),
        }

    async def browser_click(self, cdp_url: str, args: dict) -> dict:
        page, target_id = await self._resolve(cdp_url, _target(args))
        selector = str(args.get("selector") or "")
        if not selector:
            snap = await self._snapshot(page, target_id)
            snap["ok"] = False
            snap["reason"] = "missing_selector"
            return snap
        await page.locator(selector).first.click(timeout=12000)
        return await self._snapshot(page, target_id, attention=False)

    async def browser_screenshot(self, cdp_url: str, args: dict) -> dict:
        page, target_id = await self._resolve(cdp_url, _target(args))
        await page.screenshot(type="png", timeout=12000)
        return await self._snapshot(page, target_id, attention=False)

    async def _resolve(self, cdp_url: str, target_id: str | None):
        await self.connect(cdp_url)
        pages = self._pages.get(cdp_url) or {}
        if target_id and target_id in pages:
            page = pages[target_id]
            await self._install_web_bot_auth(page)
            return page, target_id
        last = self._last.get(cdp_url)
        if last and last in pages:
            page = pages[last]
            await self._install_web_bot_auth(page)
            return page, last
        if pages:
            found = next(reversed(pages))
            page = pages[found]
            await self._install_web_bot_auth(page)
            return page, found
        raise RuntimeError("no browser page")

    def _remember(self, cdp_url: str, target_id: str, page) -> None:
        self._pages.setdefault(cdp_url, {})[target_id] = page
        self._last[cdp_url] = target_id

    async def _snapshot(self, page, target_id: str, attention: bool = False) -> dict:
        text = await _body_text(page)
        return {
            "targetId": target_id,
            "url": page.url,
            "title": await page.title(),
            "text": text[:8000],
            "attention": attention_of(text) if attention else None,
        }


def _target(args: dict) -> str | None:
    value = args.get("targetId") or args.get("target_id")
    return str(value) if value else None


def _empty(reason: str) -> dict:
    return {
        "ok": False,
        "reason": reason,
        "targetId": "",
        "url": "",
        "title": "",
        "text": "",
        "attention": None,
    }


async def _target_id(context, page) -> str:
    session = await context.new_cdp_session(page)
    try:
        info = await session.send("Target.getTargetInfo")
    finally:
        try:
            await session.detach()
        except Exception:
            pass
    return info["targetInfo"]["targetId"]


async def _body_text(page) -> str:
    try:
        return await page.inner_text("body", timeout=5000)
    except Exception:
        return ""
