import fs from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const owner = process.env.OWNER_USERNAME ?? "saad";
const password = process.env.OWNER_PASSWORD ?? "teammates-dev";
const OPENROUTER = "sk-or-v1-CANARYOPENROUTERKEY8Kx2";

const created: string[] = [];

async function login(page: Page) {
  await page.addInitScript(() => localStorage.setItem("teammates-theme", "light"));
  await page.goto("/login");
  await page.getByTestId("login-username").fill(owner);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("app-shell")).toBeVisible();
}

async function makeBot(page: Page, name: string): Promise<string> {
  const response = await page.request.post("/api/bots", { data: { name, role: "test" } });
  expect(response.ok()).toBeTruthy();
  const bot = (await response.json()) as { id: string };
  created.push(bot.id);
  return bot.id;
}

async function say(page: Page, text: string) {
  await page.getByTestId("composer").fill(text);
  await page.getByTestId("send-chat").click();
}

async function shot(page: Page, name: string) {
  fs.mkdirSync("/workspace/ai-teammates-live/shots", { recursive: true });
  await page.screenshot({ path: `/workspace/ai-teammates-live/shots/${name}.png` });
}

test.afterEach(async ({ page }) => {
  for (const id of created.splice(0)) await page.request.delete(`/api/bots/${id}`).catch(() => null);
});

test("a bot asks first, messages its peer, and both chats show the thread row", async ({ page }) => {
  test.setTimeout(150_000);
  await login(page);
  const secret = await page.request.post("/api/secrets", { data: { namespace: "openrouter", name: "default", type: "API_KEY", value: OPENROUTER } });
  expect(secret.ok()).toBeTruthy();
  const tag = Math.random().toString(36).slice(2, 7);
  const alpha = `Alpha${tag}`;
  const beta = `Beta${tag}`;
  const alphaId = await makeBot(page, alpha);
  const betaId = await makeBot(page, beta);

  await page.goto(`/bots/${alphaId}`);
  await expect(page.getByTestId("composer")).toBeVisible();
  await say(page, `Ask ${beta} to double 21`);

  const card = page.getByTestId("approval-card").first();
  await expect(card).toBeVisible({ timeout: 60_000 });
  await card.getByTestId("approve-once").click();

  const row = page.getByTestId("bot-thread-row").first();
  await expect(row).toBeVisible({ timeout: 60_000 });
  await expect(row).toContainText(`Messaged ${beta}`);
  await expect(page.getByTestId("bot-thread-status").first()).toHaveText(/replied/i, { timeout: 60_000 });
  await shot(page, "8-bot-messaging");

  await row.click();
  const dialog = page.getByTestId("bot-thread-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("thread-message").first()).toBeVisible();
  await expect(dialog).toContainText("42");
  await page.getByTestId("thread-close").click().catch(() => page.keyboard.press("Escape"));
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // The receiving chat shows the same thread as received.
  await page.goto(`/bots/${betaId}`);
  const received = page.getByTestId("bot-thread-row").first();
  await expect(received).toBeVisible({ timeout: 30_000 });
  await expect(received).toContainText(alpha);
});

test("a forced-ask approval from a peer shows in both chats and one decision clears both", async ({ page }) => {
  test.setTimeout(150_000);
  await login(page);
  expect((await page.request.post("/api/secrets", { data: { namespace: "openrouter", name: "default", type: "API_KEY", value: OPENROUTER } })).ok()).toBeTruthy();
  const tag = Math.random().toString(36).slice(2, 7);
  const beta = `Beta${tag}`;
  const alphaId = await makeBot(page, `Alpha${tag}`);
  const betaId = await makeBot(page, beta);

  await page.goto(`/bots/${alphaId}`);
  await say(page, `Ask ${beta} to delete the secret file`);
  await expect(page.getByTestId("approval-card").first()).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("approve-once").first().click();

  // The peer wants to delete a file. Alpha's chat shows the relayed card.
  const relayed = page.getByTestId("approval-card").filter({ has: page.getByTestId("approval-relayed") });
  await expect(relayed.first()).toBeVisible({ timeout: 90_000 });

  const page2 = await page.context().newPage();
  await page2.goto(`/bots/${betaId}`);
  await expect(page2.getByTestId("approval-card").first()).toBeVisible({ timeout: 30_000 });

  await relayed.first().getByTestId("deny").click();
  await expect(page.locator('[data-testid="approval-card"]:not([data-decided])')).toHaveCount(0, { timeout: 30_000 });
  await page2.reload();
  await expect(page2.locator('[data-testid="approval-card"]:not([data-decided])')).toHaveCount(0, { timeout: 30_000 });
  await page2.close();
});

test("the teammate settings switch turns peer messaging off", async ({ page }) => {
  await login(page);
  const id = await makeBot(page, `Switch${Math.random().toString(36).slice(2, 7)}`);
  await page.goto(`/bots/${id}`);
  await page.getByTestId("bot-settings-gear").click();
  const toggle = page.getByTestId("settings-peer-messaging");
  await expect(toggle).toBeChecked();
  await toggle.click();
  await page.getByTestId("bot-settings").getByRole("button", { name: /save/i }).click();
  await expect.poll(async () => {
    const response = await page.request.get("/api/bots");
    const bots = (await response.json()) as { id: string; peerMessaging?: boolean }[];
    return bots.find((bot) => bot.id === id)?.peerMessaging;
  }, { timeout: 15_000 }).toBe(false);
});
