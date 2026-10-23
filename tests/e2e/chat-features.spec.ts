import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const bots = [
  { id: A, name: "ATLAS", role: "Chief of staff", section: "Teammates", avatar: "", avatarShape: "blob1", avatarColor: "#ff3045", isPrimary: true, bio: "Runs the day", attention: false },
  { id: B, name: "Nova", role: "Teammate", section: "Teammates", avatar: "", avatarShape: "blob3", avatarColor: "#4f46e5", isPrimary: false, bio: "", attention: false },
];

type Mock = { messages: Array<Record<string, unknown>>; tasks: Array<Record<string, unknown>>; posts: Array<Record<string, any>>; calls: string[] };

async function setup(page: Page, opts: { messages?: Array<Record<string, unknown>>; tasks?: Array<Record<string, unknown>> } = {}): Promise<Mock> {
  const mock: Mock = { messages: opts.messages ?? [], tasks: opts.tasks ?? [], posts: [], calls: [] };
  await login(page);
  await page.route("**/api/bots", route => route.fulfill({ json: { bots } }));
  for (const bot of bots) {
    await page.route(`**/api/bots/${bot.id}/**`, route => route.fulfill({ json: [] }));
    await page.route("**/api/system/llm-status", route => route.fulfill({ json: { hasKey: true } }));
    await page.route(`**/api/bots/${bot.id}/workspace`, route => route.fulfill({ json: {
      bot, conversationId: bot.id, tasks: mock.tasks, messages: mock.messages, approvals: [], pages: [], holder: "agent", openrouterConnected: true,
    } }));
    await page.route(`**/api/conversations/${bot.id}/messages`, async route => {
      const data = route.request().postDataJSON();
      mock.posts.push(data);
      const flat = data.parts ? data.parts.map((p: any) => (p.type === "quote" ? p.text.split("\n").map((l: string) => `> ${l}`).join("\n") : p.text ?? "")).join("\n\n") : data.content;
      mock.messages = [...mock.messages, { id: `u${mock.messages.length}`, role: "user", content: flat, parts: data.parts, createdAt: new Date().toISOString() }];
      await route.fulfill({ json: { ok: true } });
    });
  }
  await page.route("**/api/messages/*/reactions", async route => { mock.calls.push(`react ${route.request().postDataJSON().emoji}`); await route.fulfill({ json: { ok: true } }); });
  await page.route("**/api/messages/*", async route => {
    if (route.request().method() === "DELETE") {
      const id = route.request().url().split("/").pop();
      mock.calls.push(`delete ${id}`);
      mock.messages = mock.messages.map(m => (m.id === id ? { ...m, deleted: true, content: "" } : m));
      await route.fulfill({ json: { ok: true } });
    } else await route.fallback();
  });
  return mock;
}

const assistant = (id: string, content: string, extra: Record<string, unknown> = {}) => ({ id, role: "assistant", content, createdAt: new Date().toISOString(), requestId: "req_123", ...extra });

async function selectText(page: Page, locator: string, text: string) {
  await page.evaluate(({ locator, text }) => {
    const root = document.querySelector(locator)!;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const i = node.textContent!.indexOf(text);
      if (i >= 0) {
        const range = document.createRange();
        range.setStart(node, i); range.setEnd(node, i + text.length);
        const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
        document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        return;
      }
    }
    throw new Error("text not found");
  }, { locator, text });
}

test("composer placeholder follows the bot, shows a round + button, and the accent follows the bot colour", async ({ page }) => {
  await setup(page);
  await page.goto(`/bots/${A}`);
  const composer = page.getByTestId("composer");
  await expect(composer).toHaveAttribute("placeholder", "Message ATLAS");
  await expect(page.getByTestId("composer-plus")).toBeVisible();
  const accentA = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bot-accent").trim());
  await page.getByRole("link", { name: /Nova/ }).first().click();
  await expect(page.getByTestId("composer")).toHaveAttribute("placeholder", "Message Nova");
  const accentB = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bot-accent").trim());
  expect(accentA).not.toBe("");
  expect(accentB).not.toBe(accentA);
  await page.getByTestId("composer-plus").click();
  await expect(page.getByTestId("plus-attach")).toBeVisible();
  await expect(page.getByTestId("plus-quote")).toBeVisible();
});

test("Add to chat: selection pill, ordered quote and text parts, sent bubble with quote", async ({ page }) => {
  const mock = await setup(page, { messages: [assistant("a1", "The deploy finished with three warnings about caching.")] });
  await page.goto(`/bots/${A}`);
  await expect(page.getByTestId("message-item")).toHaveCount(1);
  await selectText(page, "[data-testid='message-item']", "three warnings");
  const pill = page.getByTestId("add-to-chat");
  await expect(pill).toBeVisible();
  await pill.click();
  await expect(page.getByTestId("composer-quote")).toContainText("three warnings");
  await expect(pill).toHaveCount(0);
  await page.getByTestId("composer").fill("What should I do about these?");
  await page.getByTestId("send-chat").click();
  await expect.poll(() => mock.posts.length).toBe(1);
  expect(mock.posts[0].parts.map((p: any) => p.type)).toEqual(["quote", "text"]);
  expect(mock.posts[0].parts[0].text).toBe("three warnings");
  await page.reload();
  const bubble = page.getByTestId("user-bubble");
  await expect(bubble.getByTestId("quote-block")).toContainText("three warnings");
  await expect(bubble).toContainText("What should I do about these?");
});

test("Ctrl+L adds the current selection, duplicates are ignored, Backspace removes an empty segment's quote", async ({ page }) => {
  await setup(page, { messages: [assistant("a1", "Alpha beta gamma")] });
  await page.goto(`/bots/${A}`);
  await selectText(page, "[data-testid='message-item']", "beta");
  await page.keyboard.press("Control+l");
  await expect(page.getByTestId("composer-quote")).toHaveCount(1);
  await selectText(page, "[data-testid='message-item']", "beta");
  await page.keyboard.press("Control+l");
  await expect(page.getByTestId("composer-quote")).toHaveCount(1);
  await page.getByTestId("composer").press("Backspace");
  await expect(page.getByTestId("composer-quote")).toHaveCount(0);
});

test("hover toolbar: react, reply, menu, delete with confirm, also on user messages", async ({ page }) => {
  const mock = await setup(page, { messages: [
    { id: "u1", role: "user", content: "hello there", createdAt: new Date().toISOString() },
    assistant("a1", "Hi! How can I help?"),
  ] });
  await page.goto(`/bots/${A}`);
  const reply = page.locator("[data-message-id='a1']");
  await reply.hover();
  await expect(reply.getByTestId("message-toolbar")).toBeVisible();
  // react via popover
  await reply.getByTestId("msg-react").click();
  await page.getByRole("button", { name: "React 🎉" }).click();
  await expect.poll(() => mock.calls).toContain("react 🎉");
  // reply block
  await reply.hover();
  await reply.getByTestId("msg-reply").click();
  await expect(page.getByTestId("composer-reply")).toContainText("Hi! How can I help?");
  await page.getByTestId("composer").fill("thanks");
  await page.getByTestId("send-chat").click();
  await expect.poll(() => mock.posts.length).toBe(1);
  expect(mock.posts[0].parts.map((p: any) => p.type)).toEqual(["reply", "text"]);
  expect(mock.posts[0].parts[0].messageId).toBe("a1");
  // menu
  await reply.hover();
  await reply.getByTestId("msg-more").click();
  const menu = page.getByTestId("message-menu");
  for (const name of ["Copy", "Copy request ID", "Remember this", "Delete"]) await expect(menu.getByText(name, { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("message-menu")).toHaveCount(0);
  // toolbar on a user message
  const mine = page.locator("[data-message-id='u1']");
  await mine.hover();
  await expect(mine.getByTestId("msg-react")).toBeVisible();
  await mine.getByTestId("msg-more").click();
  await page.getByTestId("msg-delete").click();
  await page.getByTestId("confirm-delete-message").click();
  await expect.poll(() => mock.calls).toContain("delete u1");
  await expect(page.locator("[data-message-id='u1'][data-deleted='true']")).toContainText("Message deleted");
});

test("keyboard: arrow focus between messages, R replies, E opens reactions, Enter opens the menu", async ({ page }) => {
  await setup(page, { messages: [assistant("a1", "First"), assistant("a2", "Second")] });
  await page.goto(`/bots/${A}`);
  const first = page.locator("[data-message-id='a1']");
  await first.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("[data-message-id='a2']")).toBeFocused();
  await page.keyboard.press("r");
  await expect(page.getByTestId("composer-reply")).toContainText("Second");
  await expect(page.getByTestId("composer")).toBeFocused();
  await page.locator("[data-message-id='a1']").focus();
  await expect(page.locator("[data-message-id='a1']")).toBeFocused();
  await page.keyboard.press("e");
  await expect(page.getByTestId("reaction-picker")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("reaction-picker")).toHaveCount(0);
  await expect(page.locator("[data-message-id='a1']").getByTestId("msg-react")).toBeFocused();
  await page.locator("[data-message-id='a1']").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("message-menu")).toBeVisible();
});

test("working row shows the bot's own avatar and a shimmering status", async ({ page }) => {
  await setup(page, { tasks: [{ id: "t1", status: "running", title: "Updating the bot badge" }] });
  await page.goto(`/bots/${A}`);
  const row = page.getByTestId("working-row");
  await expect(row).toBeVisible();
  await expect(row.getByTestId("working-status")).toContainText("Updating the bot badge");
  await expect(row.locator("svg")).toHaveCount(1);
  await expect(row.locator(".shimmer-word").first()).toBeVisible();
  await page.emulateMedia({ reducedMotion: "reduce" });
  const anim = await row.locator(".shimmer-word").first().evaluate(el => getComputedStyle(el).animationName);
  expect(anim).toBe("none");
});

test("right panel closes with X, reopens from the name pill, remembers state, Esc closes", async ({ page }) => {
  await setup(page);
  await page.goto(`/bots/${A}`);
  const pill = page.getByTestId("bot-name-button");
  await expect(pill).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("info-pane")).toBeVisible();
  await page.getByTestId("info-pane-close").click();
  await expect(page.getByTestId("info-pane")).toHaveCount(0);
  await expect(pill).toHaveAttribute("aria-expanded", "false");
  await page.reload();
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(pill).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("info-pane")).toHaveCount(0);
  await pill.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("info-pane")).toBeVisible();
  await expect(pill).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("info-pane")).toHaveCount(0);
  await expect(pill).toBeFocused();
  expect(await page.evaluate(() => localStorage.getItem("teammates-pane"))).toBe("closed");
});

test("primary badge and bio: badge only on the primary bot, bio chip and inline edit", async ({ page }) => {
  await setup(page);
  let patched: any = null;
  await page.route(`**/api/bots/${A}`, async route => {
    if (route.request().method() === "PATCH") { patched = route.request().postDataJSON(); await route.fulfill({ json: { ok: true } }); } else await route.fallback();
  });
  await page.goto(`/bots/${A}`);
  const primary = page.getByRole("img", { name: "Primary bot" });
  await expect(primary.first()).toBeVisible();
  await expect(primary.first()).toHaveAttribute("title", "Primary bot");
  const novaRow = page.getByRole("link", { name: /Nova/ }).first();
  await expect(novaRow.getByRole("img", { name: "Primary bot" })).toHaveCount(0);
  await expect(page.getByTestId("sidebar-bio")).toHaveText("Runs the day");
  const bio = page.getByTestId("bot-bio");
  await expect(bio).toHaveValue("Runs the day");
  await bio.fill("Chief of staff");
  await bio.blur();
  await expect.poll(() => patched?.bio).toBe("Chief of staff");
});

test("accessibility: chat region has no serious axe violations", async ({ page }) => {
  await setup(page, { messages: [{ id: "u1", role: "user", content: "hello", createdAt: new Date().toISOString() }, assistant("a1", "Hi there")] });
  await page.goto(`/bots/${A}`);
  await page.locator("[data-message-id='a1']").hover();
  await page.locator("[data-message-id='a1']").getByTestId("msg-react").click();
  await expect(page.getByTestId("reaction-picker")).toBeVisible();
  const results = await new AxeBuilder({ page }).include("[data-testid='composer-bar']").include("[data-testid='reaction-picker']").include("[data-testid='message-item']").analyze();
  const bad = results.violations.filter(v => ["serious", "critical"].includes(v.impact ?? ""));
  expect(bad.map(v => `${v.id}: ${v.nodes[0]?.html.slice(0, 120)}`)).toEqual([]);
});

test("skeletons show while the roster, workspace and library load, then give way to content", async ({ page }) => {
  const mock = await setup(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/bots", async route => { await gate; await route.fulfill({ json: { bots } }); });
  await page.route(`**/api/bots/${A}/workspace`, async route => {
    await gate;
    await route.fulfill({ json: { bot: bots[0], conversationId: A, tasks: [], messages: mock.messages, approvals: [], pages: [], holder: "agent", openrouterConnected: true } });
  });
  await page.goto(`/bots/${A}`);
  await expect(page.getByTestId("sidebar-skeleton")).toBeVisible();
  await expect(page.getByTestId("chat-skeleton")).toBeVisible();
  await expect(page.getByTestId("chat-skeleton")).toHaveAttribute("aria-busy", "true");
  release();
  await expect(page.getByTestId("sidebar-skeleton")).toHaveCount(0);
  await expect(page.getByTestId("chat-skeleton")).toHaveCount(0);
  await expect(page.getByTestId("composer")).toBeVisible();
});

test("motion tokens exist, new messages slide in, and reduced motion removes the movement", async ({ page }) => {
  const mock = await setup(page, { messages: [assistant("m1", "Hello there")] });
  await page.goto(`/bots/${A}`);
  await expect(page.getByTestId("composer")).toBeVisible();
  const tokens = await page.evaluate(() => {
    const s = getComputedStyle(document.documentElement);
    return ["--motion-fast", "--motion-base", "--motion-slow", "--ease-out"].map(name => s.getPropertyValue(name).trim());
  });
  expect(tokens.slice(0, 3)).toEqual(["150ms", "200ms", "250ms"]);
  expect(tokens[3]).toContain("cubic-bezier");
  // History does not animate on load.
  await expect(page.getByTestId("message-item").first()).not.toHaveClass(/motion-rise/);
  // Buttons carry the shared press and hover transition.
  const duration = await page.getByTestId("composer-plus").evaluate(el => getComputedStyle(el).transitionDuration);
  expect(duration).toContain("0.15s");
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reduced = await page.getByTestId("composer-plus").evaluate(el => parseFloat(getComputedStyle(el).transitionDuration));
  expect(reduced).toBeLessThan(0.001);
  void mock;
});

test("screenshot: chat features (working row, quote, hover toolbar, panel)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await setup(page, {
    tasks: [{ id: "t1", status: "running", title: "Planning component animations" }],
    messages: [
      assistant("a1", "The sidebar cards now lift on hover and press. Next I will animate the panel and the dialogs."),
      { id: "u1", role: "user", content: "> The sidebar cards now lift on hover\n\nCan you also animate the toasts?", parts: [{ type: "quote", id: "q1", text: "The sidebar cards now lift on hover", source: "a1" }, { type: "text", text: "Can you also animate the toasts?" }], createdAt: new Date().toISOString() },
    ],
  });
  await page.goto(`/bots/${A}`);
  await expect(page.getByTestId("working-row")).toBeVisible();
  await expect(page.getByTestId("info-pane")).toBeVisible();
  await page.locator("[data-message-id='a1']").hover();
  await expect(page.locator("[data-message-id='a1']").getByTestId("msg-react")).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: require("path").resolve(__dirname, "../../../shots/7-chat-features.png") });
});
