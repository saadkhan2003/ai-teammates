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


test("the chat top bar is only a small floating pill; messages scroll and fade behind it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await setup(page, { messages: [msg(1, "user", "First message at the very top"), ...filler(2, 30)] });
  await page.goto(`/bots/${A}`);
  const pill = page.getByTestId("bot-name-button");
  await expect(pill).toBeVisible();
  await expect(pill).toContainText("ATLAS");
  const box = (await pill.boundingBox())!;
  expect(box.width).toBeLessThan(260);
  expect(box.height).toBeLessThan(48);
  // No full-width header row: the bar has no border and ignores the pointer outside the pill.
  const bar = page.getByTestId("chat-pill-bar");
  const style = await bar.evaluate((el) => ({ position: getComputedStyle(el).position, border: getComputedStyle(el).borderBottomWidth, events: getComputedStyle(el).pointerEvents }));
  expect(style).toEqual({ position: "absolute", border: "0px", events: "none" });
  // The message list starts at the top of the column, so messages pass behind the pill.
  const section = (await page.getByTestId("chat-scroll").boundingBox())!;
  expect(section.y).toBeLessThanOrEqual(1);
  await expect(page.getByTestId("chat-top-fade")).toBeAttached();
  // Scrolling moves messages under the pill and the pill stays put.
  await page.getByTestId("chat-scroll").evaluate((el) => { el.scrollTop = 600; });
  const after = (await pill.boundingBox())!;
  expect(after.y).toBe(box.y);
  await page.screenshot({ path: "/workspace/ai-teammates-live/shots/13-chat-pill.png" });
  // The pill still opens the details pane.
  await pill.click();
  await expect(page.getByTestId("info-pane")).toBeVisible();
  // At the top of the history the first message is not hidden by the pill.
  await page.getByTestId("chat-scroll").evaluate((el) => { el.scrollTop = 0; });
  const first = (await page.locator("[data-message-id='m1']").boundingBox())!;
  expect(first.y).toBeGreaterThanOrEqual(box.y + box.height - 2);
});
