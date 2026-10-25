import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";
import path from "node:path";

const A = "11111111-1111-4111-8111-111111111111";
const bot = { id: A, name: "ATLAS", role: "Chief of staff", section: "Teammates", avatar: "", avatarShape: "blob1", avatarColor: "#ff3045", isPrimary: true, bio: "Runs the day", attention: false };
const iso = (n: number) => new Date(Date.UTC(2026, 9, 23, 8, 0, n)).toISOString();
const msg = (n: number, role: "assistant" | "user", content: string, extra: Record<string, unknown> = {}) => ({ id: `m${n}`, role, content, createdAt: iso(n), ...extra });
const filler = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => msg(from + i, i % 2 ? "user" : "assistant", `Filler message number ${from + i}. ${"Some words to take up room in the chat. ".repeat(4)}`));
const LONG = "Yes, most of it is worth adding, but not all at once. This is my own read of the research. The day counts are estimates, not measurements. Must include (this is what makes a bot build software reliably)";

async function setup(page: Page, opts: { messages: Array<Record<string, unknown>>; hasMore?: boolean; history?: Array<Record<string, unknown>> }) {
  const state = { messages: opts.messages, historyCalls: [] as string[], posts: [] as any[] };
  await login(page);
  await page.route("**/api/bots", route => route.fulfill({ json: { bots: [bot] } }));
  await page.route("**/api/system/llm-status", route => route.fulfill({ json: { hasKey: true } }));
  await page.route(`**/api/bots/${A}/**`, route => route.fulfill({ json: [] }));
  await page.route(`**/api/bots/${A}/workspace`, route => route.fulfill({ json: { bot, conversationId: A, tasks: [], messages: state.messages, messagesHasMore: !!opts.hasMore, approvals: [], pages: [], holder: "agent", openrouterConnected: true } }));
  await page.route(new RegExp(`/api/bots/${A}/messages\\?`), async route => { state.historyCalls.push(route.request().url()); await route.fulfill({ json: { messages: opts.history ?? [], hasMore: false } }); });
  await page.route(`**/api/conversations/${A}/messages`, async route => {
    const data = route.request().postDataJSON();
    state.posts.push(data);
    state.messages = [...state.messages, msg(900 + state.messages.length, "user", "reply", { parts: data.parts })];
    await route.fulfill({ json: { ok: true } });
  });
  return state;
}

test("reply chip sits above the composer, truncates to one line, cancels with X, and the sent bubble shows a bordered quote", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await setup(page, { messages: [msg(1, "assistant", LONG), msg(2, "user", "Thanks")] });
  await page.goto(`/bots/${A}`);
  const first = page.locator("[data-message-id='m1']");
  await first.hover();
  await first.getByTestId("msg-reply").click();
  const chip = page.getByTestId("composer-reply");
  await expect(chip).toBeVisible();
  const box = (await chip.boundingBox())!;
  expect(box.height).toBeLessThan(48);
  const text = page.getByTestId("composer-reply-text");
  expect(await text.evaluate(el => el.scrollWidth > el.clientWidth || getComputedStyle(el).textOverflow === "ellipsis")).toBe(true);
  expect(await text.evaluate(el => getComputedStyle(el).whiteSpace)).toBe("nowrap");
  // the chip is above the typing box
  const input = (await page.getByLabel("Message ATLAS").boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(input.y);
  await page.screenshot({ path: path.resolve(__dirname, "../../../shots/9-reply-chip.png") });
  // cancel
  await chip.getByRole("button", { name: "Remove reply" }).click();
  await expect(chip).toHaveCount(0);
  // reply again and send
  await first.hover();
  await first.getByTestId("msg-reply").click();
  await page.getByLabel("Message ATLAS").fill("Do the first two");
  await page.getByTestId("send-chat").click();
  await expect.poll(() => state.posts.length).toBe(1);
  expect(state.posts[0].parts[0]).toMatchObject({ type: "reply", messageId: "m1" });
  await expect(page.getByTestId("composer-reply")).toHaveCount(0);
  await page.reload();
  const block = page.getByTestId("reply-block").last();
  await expect(block).toBeVisible();
  const border = await block.evaluate(el => getComputedStyle(el).borderTopWidth);
  expect(parseFloat(border)).toBeGreaterThan(0);
});

test("replying to an image includes its thumbnail in the composer chip", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await setup(page, { messages: [msg(1, "assistant", "![Diagram](/diagram.png)")] });
  await page.goto(`/bots/${A}`);
  const message = page.locator("[data-message-id='m1']");
  await message.hover();
  await message.getByTestId("msg-reply").click();
  await expect(page.getByTestId("composer-reply-image")).toHaveAttribute("src", "/diagram.png");
  await expect(page.getByTestId("composer-reply-image")).toHaveAttribute("alt", "Diagram");
});

async function phases(page: Page, id: string, ms: number) {
  return page.evaluate(({ id, ms }) => new Promise<{ t: number; v: string | null }[]>(resolve => {
    const out: { t: number; v: string | null }[] = []; const start = performance.now();
    const tick = () => { out.push({ t: performance.now() - start, v: document.getElementById(`msg-${id}`)?.getAttribute("data-jump") ?? null }); if (performance.now() - start < ms) setTimeout(tick, 100); else resolve(out); };
    tick();
  }), { id, ms });
}

test("tapping the quote scrolls to the original, highlights 3 s, then fades out over 600 ms", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const reply = msg(300, "user", "ok", { parts: [{ type: "reply", id: "r1", messageId: "m1", author: "ATLAS", excerpt: LONG.slice(0, 80) }, { type: "text", text: "Do the first two" }] });
  await setup(page, { messages: [msg(1, "assistant", "ORIGINAL target message"), ...filler(2, 40), reply] });
  await page.goto(`/bots/${A}`);
  await expect(page.getByTestId("reply-block")).toBeVisible();
  await expect(page.locator("#msg-m1")).toBeAttached();
  await page.getByTestId("reply-block").click();
  const timeline = await phases(page, "m1", 4600);
  const on = timeline.filter(s => s.v === "on"), fade = timeline.filter(s => s.v === "fade");
  expect(on.length).toBeGreaterThan(20);
  expect(on[0].t).toBeLessThan(600);
  expect(on[on.length - 1].t).toBeGreaterThan(2800);
  expect(fade.length).toBeGreaterThan(0);
  expect(fade[0].t).toBeGreaterThan(2800);
  expect(timeline[timeline.length - 1].v).toBeNull();
  await expect(page.locator("#msg-m1")).toBeInViewport();
  const transition = await page.evaluate(() => { const n = document.getElementById("msg-m1")!; n.setAttribute("data-jump", "fade"); const c = getComputedStyle(n); const r = [c.transitionDuration, c.transitionTimingFunction]; n.removeAttribute("data-jump"); return r; });
  expect(transition[0]).toContain("0.6s");
  expect(transition[1]).toContain("cubic-bezier(0, 0, 0.2, 1)");
});

test("reduced motion: instant scroll and a brief static highlight with no fade", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 900 });
  const reply = msg(300, "user", "ok", { parts: [{ type: "reply", id: "r1", messageId: "m1", author: "ATLAS", excerpt: "ORIGINAL" }, { type: "text", text: "go" }] });
  await setup(page, { messages: [msg(1, "assistant", "ORIGINAL target message"), ...filler(2, 40), reply] });
  await page.goto(`/bots/${A}`);
  await page.getByTestId("reply-block").click();
  const timeline = await phases(page, "m1", 1800);
  expect(timeline.some(s => s.v === "on")).toBe(true);
  expect(timeline.some(s => s.v === "fade")).toBe(false);
  expect(timeline[timeline.length - 1].v).toBeNull();
  await expect(page.locator("#msg-m1")).toBeInViewport();
});

test("when the original is not loaded, history loads up to it and then it is highlighted", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const reply = msg(300, "user", "ok", { parts: [{ type: "reply", id: "r1", messageId: "m1", author: "ATLAS", excerpt: "ORIGINAL" }, { type: "text", text: "go" }] });
  const state = await setup(page, { messages: [...filler(200, 230), reply], hasMore: true, history: [msg(1, "assistant", "ORIGINAL target message"), ...filler(2, 30)] });
  await page.goto(`/bots/${A}`);
  await expect(page.locator("#msg-m1")).toHaveCount(0);
  await expect(page.getByTestId("reply-block")).toBeEnabled();
  await page.getByTestId("reply-block").click();
  await expect(page.locator("#msg-m1")).toHaveAttribute("data-jump", "on");
  expect(state.historyCalls.length).toBe(1);
  expect(state.historyCalls[0]).toContain("before=m200");
  await expect(page.locator("#msg-m1")).toBeInViewport();
  await page.screenshot({ path: path.resolve(__dirname, "../../../shots/9-reply-jump.png") });
});
