"""CDP browser control. The secret value is only used inside type_secret and never logged."""
from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path
from urllib.parse import urlsplit

import workspace
import box_contract
from desktops import DesktopManager, cdp_port
from pure import attention_reason, looks_like_phish, origin_of, redact, scrub_tree
try:
    from .private_browser import block_normal_browser_private_hosts
except ImportError:
    from private_browser import block_normal_browser_private_hosts


class BrowserHub:
    def __init__(self, desks: DesktopManager) -> None:
        self.playwright: Playwright | None = None
        self.desks = desks
        self.browsers: dict[str, PwBrowser] = {}
        self.pages: dict[str, dict[str, object]] = {}
        self._connect_locks: dict[str, asyncio.Lock] = {}
        self._cookies_restored: set[str] = set()

    async def close(self) -> None:
        for browser in self.browsers.values():
            try:
                await browser.close()
            except Exception:
                pass
        if self.playwright is not None:
            await self.playwright.stop()
            self.playwright = None

    async def _runtime(self):
        if self.playwright is None:
            from playwright.async_api import async_playwright
            self.playwright = await async_playwright().start()
        return self.playwright

    def _lock(self, bot_id: str) -> asyncio.Lock:
        if bot_id not in self._connect_locks:
            self._connect_locks[bot_id] = asyncio.Lock()
        return self._connect_locks[bot_id]

    async def connect(self, bot_id: str) -> PwBrowser:
        async with self._lock(bot_id):
            existing = self.browsers.get(bot_id)
            if existing and existing.is_connected():
                return existing
            desk = self.desks.desktops[bot_id]
            last_error: Exception | None = None
            for _ in range(20):
                try:
                    runtime = await self._runtime()
                    browser = await runtime.chromium.connect_over_cdp(
                        f"http://127.0.0.1:{cdp_port(desk.display)}"
                    )
                    self.browsers[bot_id] = browser
                    self.pages[bot_id] = {}
                    await self._restore_cookies(bot_id, browser)
                    return browser
                except Exception as exc:
                    last_error = exc
                    await asyncio.sleep(0.4)
            raise RuntimeError(f"CDP connect failed: {last_error}")

    async def reconnect(self, bot_id: str) -> None:
        existing = self.browsers.pop(bot_id, None)
        self.pages.pop(bot_id, None)
        if existing:
            try:
                await existing.close()
            except Exception:
                pass
        await self.connect(bot_id)

    def _context(self, browser: PwBrowser):
        if browser.contexts:
            return browser.contexts[0]
        raise RuntimeError("chrome has no default context")

    async def _target_id(self, context, page) -> str:
        session = await context.new_cdp_session(page)
        info = await session.send("Target.getTargetInfo")
        return info["targetInfo"]["targetId"]

    def _page(self, bot_id: str, target_id: str):
        page = self.pages.get(bot_id, {}).get(target_id)
        if page is None:
            raise KeyError(target_id)
        return page

    async def _trim_tabs(self, bot_id: str, context) -> None:
        """Keep a computer light: close the oldest tabs so renderers never exhaust the container."""
        limit = max(2, int(os.environ.get("COMPUTER_MAX_TABS", "8")))
        try:
            pages = list(context.pages)
            excess = len(pages) - (limit - 1)
            if excess <= 0:
                return
            tracked = self.pages.get(bot_id, {})
            for page in pages[:excess]:
                try:
                    await page.close()
                except Exception:
                    pass
                for target_id, known in list(tracked.items()):
                    if known is page:
                        tracked.pop(target_id, None)
        except Exception:
            pass

    async def open_tab(self, bot_id: str, url: str, wait: str | None) -> dict:
        browser = await self.connect(bot_id)
        context = self._context(browser)
        await self._trim_tabs(bot_id, context)
        page = await context.new_page()
        await block_normal_browser_private_hosts(page)
        await page.goto(url, wait_until="domcontentloaded", timeout=20000)
        if wait:
            try:
                await page.wait_for_selector(wait, state="visible", timeout=12000)
            except Exception:
                pass
        else:
            try:
                await page.wait_for_load_state("networkidle", timeout=2500)
            except Exception:
                pass
        target_id = await self._target_id(context, page)
        self.pages.setdefault(bot_id, {})[target_id] = page
        text = await self._visible_text(page)
        return {
            "targetId": target_id,
            "url": page.url,
            "title": await page.title(),
            "origin": origin_of(page.url),
            "text": text[:4000],
            "attention": attention_reason(text),
        }

    async def extract(self, bot_id: str, target_id: str | None, selector: str | None) -> dict:
        page = await self._resolve_page(bot_id, target_id)
        if selector:
            try:
                text = await page.locator(selector).first.inner_text(timeout=5000)
            except Exception:
                text = await self._visible_text(page)
        else:
            text = await self._visible_text(page)
        text = redact(text)
        return {
            "targetId": target_id or await self._id_of(bot_id, page),
            "url": page.url,
            "title": await page.title(),
            "origin": origin_of(page.url),
            "text": text[:8000],
            "attention": attention_reason(text),
        }

    async def inspect(self, bot_id: str, target_id: str, selector: str) -> dict:
        page = self._page(bot_id, target_id)
        locator = page.locator(selector).first
        try:
            handle = await locator.element_handle(timeout=5000)
        except Exception:
            handle = None
        if handle is None:
            return {
                "topOrigin": origin_of(page.url),
                "frameOrigin": "",
                "elementOk": False,
            }
        frame = await handle.owner_frame()
        info = await locator.evaluate(
            """el => ({
                tag: (el.tagName || '').toLowerCase(),
                type: (el.getAttribute('type') || '').toLowerCase(),
                cred: el.getAttribute('data-credential') || ''
            })"""
        )
        credential = info["type"] == "password" or info["cred"] == "true"
        return {
            "topOrigin": origin_of(page.url),
            "frameOrigin": origin_of(frame.url if frame else page.url),
            "elementOk": bool(credential and info["tag"] == "input"),
        }

    async def type_secret(self, bot_id: str, target_id: str, selector: str, value: str, expected_origin: str) -> dict:
        page = self._page(bot_id, target_id)
        locator = page.locator(selector).first
        try:
            handle = await locator.element_handle(timeout=5000)
        except Exception:
            return {"ok": False, "reason": "element_invalid"}
        if handle is None:
            return {"ok": False, "reason": "element_invalid"}
        frame = await handle.owner_frame()
        actual = origin_of(frame.url if frame else page.url)
        if not expected_origin or actual != origin_of(expected_origin) or looks_like_phish(host_of(actual)):
            return {"ok": False, "reason": "domain_not_allowed"}
        try:
            info = await locator.evaluate(
                """el => ({
                    tag: (el.tagName || '').toLowerCase(),
                    type: (el.getAttribute('type') || '').toLowerCase(),
                    cred: el.getAttribute('data-credential') || ''
                })"""
            )
        except Exception:
            return {"ok": False, "reason": "element_invalid"}
        if info["tag"] != "input" or not (info["type"] == "password" or info["cred"] == "true"):
            return {"ok": False, "reason": "element_invalid"}
        try:
            await locator.fill(value, timeout=5000)
        except Exception:
            return {"ok": False, "reason": "inject_failed"}
        return {"ok": True}

    async def fill_login(self, bot_id: str, target_id: str, fields: list, expected_origin: str, submit_selector: str) -> dict:
        """Type login fields only when the live frame matches the requested origin. Values are not returned."""
        await self.list_pages(bot_id)
        try:
            page = self._page(bot_id, target_id) if target_id else await self._resolve_page(bot_id, None)
        except KeyError:
            page = await self._resolve_page(bot_id, None)
        actual = origin_of(page.url)
        if not expected_origin or actual != origin_of(expected_origin) or looks_like_phish(host_of(actual)):
            return {"ok": False, "reason": "domain_not_allowed"}
        typed: list[str] = []
        try:
            for field in fields:
                if not isinstance(field, dict):
                    return {"ok": False, "reason": "element_invalid"}
                selector = str(field.get("selector") or "")
                value = str(field.get("value") or "")
                if not selector or not value:
                    return {"ok": False, "reason": "element_invalid"}
                locator = page.locator(selector).first
                try:
                    handle = await locator.element_handle(timeout=5000)
                except Exception:
                    handle = None
                if handle is None:
                    return {"ok": False, "reason": "element_invalid"}
                frame = await handle.owner_frame()
                frame_origin = origin_of(frame.url if frame else page.url)
                if frame_origin != origin_of(expected_origin) or looks_like_phish(host_of(frame_origin)):
                    return {"ok": False, "reason": "domain_not_allowed"}
                try:
                    await locator.fill(value, timeout=5000)
                except Exception:
                    return {"ok": False, "reason": "inject_failed"}
                typed.append("")
                field["value"] = ""
                value = ""
            if submit_selector:
                await page.locator(submit_selector).first.click(timeout=5000)
            else:
                await page.locator("form").first.evaluate(
                    "form => form.requestSubmit ? form.requestSubmit() : form.submit()"
                )
            text = await self._visible_text(page)
            return {
                "ok": True,
                "attention": attention_reason(text),
                "loggedIn": "logged in" in text.lower(),
            }
        finally:
            for index in range(len(typed)):
                typed[index] = ""
            typed.clear()

    async def click(self, bot_id: str, target_id: str, selector: str) -> dict:
        page = self._page(bot_id, target_id)
        await page.locator(selector).first.click(timeout=5000)
        return {"ok": True, "url": page.url}

    async def human_click(self, bot_id: str, target_id: str, selector: str) -> dict:
        desk = self.desks.desktops[bot_id]
        if desk.holder != "human":
            return {"ok": False, "reason": "not_holder"}
        page = self._page(bot_id, target_id)
        box = await page.locator(selector).first.bounding_box(timeout=5000)
        if not box:
            return {"ok": False, "reason": "element_invalid"}
        meta = await page.evaluate(
            """() => ({
                sx: window.screenX || 0,
                sy: window.screenY || 0,
                chrome: Math.max((window.outerHeight || 0) - (window.innerHeight || 0), 0)
            })"""
        )
        x = int(meta["sx"] + box["x"] + box["width"] / 2)
        y = int(meta["sy"] + meta["chrome"] + box["y"] + box["height"] / 2)
        proc = await asyncio.create_subprocess_exec(
            "xdotool", "mousemove", "--screen", "0", str(x), str(y), "click", "1",
            env={"DISPLAY": f":{desk.display}", "HOME": "/data/home/desk", "PATH": "/usr/bin:/bin"},
        )
        code = await proc.wait()
        return {"ok": code == 0, "x": x, "y": y}

    async def screenshot(self, bot_id: str, target_id: str | None) -> bytes:
        page = await self._resolve_page(bot_id, target_id)
        return await page.screenshot(type="png")

    def _cookie_file(self, bot_id: str) -> Path:
        return Path("/data/profiles") / bot_id / "teammates-cookies.json"

    async def set_cookie(self, bot_id: str, name: str, value: str, url: str) -> None:
        # Chrome keeps CDP cookies in memory until it exits cleanly. A Docker
        # restart can SIGKILL it first, so the durable copy lives on the
        # profile volume and is replayed the next time we attach.
        record = {
            "name": name,
            "value": value,
            "url": url,
            "expires": int(time.time()) + 60 * 60 * 24 * 30,
        }
        path = self._cookie_file(bot_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        existing: list = []
        if path.exists():
            try:
                existing = json.loads(path.read_text() or "[]")
            except json.JSONDecodeError:
                existing = []
        existing = [item for item in existing if not (item.get("name") == name and item.get("url") == url)]
        existing.append(record)
        path.write_text(json.dumps(existing))
        browser = await self.connect(bot_id)
        await self._context(browser).add_cookies([record])

    async def _restore_cookies(self, bot_id: str, browser: PwBrowser) -> None:
        if bot_id in self._cookies_restored:
            return
        self._cookies_restored.add(bot_id)
        path = self._cookie_file(bot_id)
        if not path.exists():
            return
        try:
            rows = json.loads(path.read_text() or "[]")
        except json.JSONDecodeError:
            return
        if rows:
            await self._context(browser).add_cookies(rows)

    async def cookies(self, bot_id: str) -> list[dict]:
        browser = await self.connect(bot_id)
        context = self._context(browser)
        found = await context.cookies()
        return [
            {"name": item["name"], "value": item["value"], "domain": item.get("domain", ""), "path": item.get("path", "/")}
            for item in found
        ]

    async def page_with_selector(self, bot_id: str, pages: list[dict], selector: str) -> str | None:
        # The newest tab is not always last. Look for the element before clicking.
        for row in reversed(pages):
            page = self.pages.get(bot_id, {}).get(str(row.get("targetId") or ""))
            if page is None:
                continue
            try:
                box = await page.locator(selector).first.bounding_box(timeout=800)
            except Exception:
                box = None
            if box:
                return str(row["targetId"])
        return None

    async def list_pages(self, bot_id: str) -> list[dict]:
        if bot_id not in self.desks.desktops or not self.desks.desktops[bot_id].chrome:
            return []
        browser = await self.connect(bot_id)
        context = self._context(browser)
        rows = []
        known = {id(page): tid for tid, page in self.pages.get(bot_id, {}).items()}
        for page in context.pages:
            if page.url.startswith("devtools:"):
                continue
            target_id = known.get(id(page))
            if target_id is None:
                target_id = await self._target_id(context, page)
                self.pages.setdefault(bot_id, {})[target_id] = page
            rows.append({"targetId": target_id, "url": page.url, "title": await page.title()})
        return rows

    async def _resolve_page(self, bot_id: str, target_id: str | None):
        await self.connect(bot_id)
        if target_id:
            return self._page(bot_id, target_id)
        pages = self.pages.get(bot_id) or {}
        if pages:
            return next(reversed(pages.values()))
        listed = await self.list_pages(bot_id)
        if not listed:
            raise KeyError("no pages")
        return self._page(bot_id, listed[-1]["targetId"])

    async def _id_of(self, bot_id: str, page) -> str:
        for tid, candidate in self.pages.get(bot_id, {}).items():
            if candidate is page:
                return tid
        return ""

    async def _visible_text(self, page) -> str:
        try:
            text = await page.inner_text("body", timeout=5000)
        except Exception:
            text = ""
        return redact(text)


async def run_command(bot_id: str, command: str, extra_env: dict[str, str] | None, timeout: int, scrub: list[str]) -> dict:
    for value in scrub:
        if value and value in command:
            return {"exitCode": 126, "stdout": "", "stderr": "command contains a resolved secret", "rejected": True}
    uid, root, home = workspace.prepare(bot_id)
    command = workspace.rewrite_command(command, root)
    env = {
        "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "HOME": str(home),
        "BOT_ROOT": str(root),
        "BOT_ID": workspace.safe_id(bot_id),
        "LANG": "C.UTF-8",
        "TERM": "xterm",
        # Shell tools and Chrome share the same local policy enforcement point.
        "HTTP_PROXY": f"http://127.0.0.1:{box_contract.EGRESS_PROXY}",
        "HTTPS_PROXY": f"http://127.0.0.1:{box_contract.EGRESS_PROXY}",
        "ALL_PROXY": f"http://127.0.0.1:{box_contract.EGRESS_PROXY}",
        "http_proxy": f"http://127.0.0.1:{box_contract.EGRESS_PROXY}",
        "https_proxy": f"http://127.0.0.1:{box_contract.EGRESS_PROXY}",
        "all_proxy": f"http://127.0.0.1:{box_contract.EGRESS_PROXY}",
        "NO_PROXY": "localhost,127.0.0.1,::1",
        "no_proxy": "localhost,127.0.0.1,::1",
    }
    if extra_env:
        env.update(extra_env)

    def drop() -> None:
        if os.geteuid() != 0:
            return
        os.setgroups([])
        os.setgid(uid)
        os.setuid(uid)

    proc = await asyncio.create_subprocess_exec(
        "bash", "-lc", command,
        cwd=str(root),
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        preexec_fn=drop,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout)
        code = proc.returncode
    except asyncio.TimeoutError:
        proc.kill()
        return {"exitCode": -1, "stdout": "", "stderr": "timeout", "rejected": False}
    scrub_tree(scrub, root)
    out = redact(stdout.decode(errors="replace")[-20000:], scrub)
    err = redact(stderr.decode(errors="replace")[-8000:], scrub)
    return {"exitCode": code, "stdout": out, "stderr": err, "rejected": False}


def host_of(url: str) -> str:
    parts = urlsplit(url)
    return parts.hostname or ""
