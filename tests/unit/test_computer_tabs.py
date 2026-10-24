"""A computer keeps a bounded number of tabs so renderers cannot exhaust its memory."""
import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class FakePage:
    def __init__(self, name):
        self.name = name
        self.closed = False

    async def close(self):
        self.closed = True


class FakeContext:
    def __init__(self, pages):
        self.pages = pages


def test_trim_tabs_closes_oldest(monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / "services/computer/src"))
    monkeypatch.setenv("COMPUTER_MAX_TABS", "4")
    sys.modules.pop("browser", None)
    import browser

    hub = browser.BrowserHub(desks=None)
    pages = [FakePage(str(i)) for i in range(6)]
    hub.pages["bot"] = {f"t{i}": page for i, page in enumerate(pages)}
    asyncio.run(hub._trim_tabs("bot", FakeContext(pages)))
    assert [p.closed for p in pages] == [True, True, True, False, False, False]
    assert set(hub.pages["bot"]) == {"t3", "t4", "t5"}


class TitledPage(FakePage):
    def __init__(self, name, crashed=False):
        super().__init__(name)
        self.url = f"https://example.test/{name}"
        self.crashed = crashed

    async def title(self):
        if self.crashed:
            raise RuntimeError("Page.title: Target crashed")
        return self.name


class FakeBrowser:
    def __init__(self, context):
        self.contexts = [context]


def test_list_pages_drops_a_crashed_tab(monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / "services/computer/src"))
    sys.modules.pop("browser", None)
    import browser

    class Desk:
        chrome = True

    class Desks:
        desktops = {"bot": Desk()}

    hub = browser.BrowserHub(desks=Desks())
    dead, live = TitledPage("dead", crashed=True), TitledPage("live")
    hub.pages["bot"] = {"t-dead": dead, "t-live": live}
    context = FakeContext([dead, live])

    async def connect(bot_id):
        return FakeBrowser(context)

    monkeypatch.setattr(hub, "connect", connect)
    rows = asyncio.run(hub.list_pages("bot"))
    assert rows == [{"targetId": "t-live", "url": live.url, "title": "live"}]
    assert dead.closed and set(hub.pages["bot"]) == {"t-live"}
