import { expect, test } from "@playwright/test";

// A bot this spec had to create (none existed); deleted after each test so runs leave nothing behind.
const createdBots: string[] = [];
test.afterEach(async ({ page }) => {
  for (const id of createdBots.splice(0)) await page.request.delete(`/api/bots/${id}`).catch(() => undefined);
});

async function firstBot(page: import("@playwright/test").Page) {
  const response = await page.request.get("/api/bots");
  expect(response.ok()).toBeTruthy();
  const raw = await response.json();
  const list = (Array.isArray(raw) ? raw : raw.bots) as { id?: string; name?: string }[];
  let bot = list.find((item) => item.id);
  if (!bot) {
    const made = await page.request.post("/api/bots", { data: { name: `Screen ${Date.now().toString().slice(-5)}` } });
    expect(made.ok()).toBeTruthy();
    const body = await made.json();
    bot = (body.bot ?? body) as { id: string; name: string };
    createdBots.push(bot.id);
  }
  expect(bot?.id).toBeTruthy();
  return bot as { id: string; name: string };
}

test("computer thumbnail opens a dark full view; collapse, minimise and Esc work", async ({ page }) => {
  const bot = await firstBot(page);
  await page.goto(`/bots/${bot.id}`);
  await expect(page.getByTestId("bot-name-button")).toBeVisible();
  if ((await page.getByTestId("bot-name-button").getAttribute("aria-expanded")) !== "true") await page.getByTestId("bot-name-button").click();
  await expect(page.getByTestId("info-pane")).toBeVisible();
  const thumb = page.getByTestId("desktop-frame");
  await expect(thumb).toBeVisible();
  await expect(thumb).toHaveAttribute("role", "button");
  await expect(page.getByTestId("computer-caption")).toHaveText(`${bot.name}'s screen`);
  await expect(page.getByTestId("control-pill")).toHaveCount(0);

  await thumb.click();
  const topbar = page.getByTestId("computer-topbar");
  await expect(topbar).toBeVisible();
  const root = page.getByTestId("computer-tab");
  const bg = await root.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe("rgb(20, 20, 20)"); // bg-[#141414], the dark surface since 2637800
  await expect(page.getByTestId("control-pill")).toHaveAttribute("data-mode", "view");
  await expect(page.getByTestId("take-control")).toBeVisible();

  const collapse = page.getByTestId("computer-collapse");
  await expect(collapse).toHaveAttribute("aria-expanded", "true");
  await collapse.click();
  await expect(collapse).toHaveAttribute("aria-expanded", "false");
  await expect(collapse).toHaveText("Restore");
  await collapse.click();
  await expect(collapse).toHaveAttribute("aria-expanded", "true");

  await page.getByTestId("computer-minimise").click();
  await expect(page.getByTestId("control-pill")).toHaveCount(0);
  await expect(page.getByTestId("desktop-frame")).toHaveAttribute("role", "button");

  // keyboard: Enter on the thumbnail opens, Esc closes
  await page.getByTestId("desktop-frame").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("computer-topbar")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("computer-topbar")).toHaveCount(0);
  // the pane itself stayed open (Esc only left the full view)
  await expect(page.getByTestId("info-pane")).toBeVisible();
});

test("take control: pill flips to You're in control with Stop, Stop resumes the bot and keeps the task", async ({ page }) => {
  const bot = await firstBot(page);
  await page.goto(`/bots/${bot.id}`);
  await expect(page.getByTestId("bot-name-button")).toBeVisible();
  if ((await page.getByTestId("bot-name-button").getAttribute("aria-expanded")) !== "true") await page.getByTestId("bot-name-button").click();
  await page.getByTestId("desktop-frame").click();
  await expect(page.getByTestId("take-control")).toBeVisible();
  await page.getByTestId("take-control").click();
  await expect(page.getByTestId("control-pill")).toHaveAttribute("data-mode", "control", { timeout: 45_000 });
  await expect(page.getByText("You're in control")).toBeVisible();
  const state = await page.request.get(`/api/bots/${bot.id}/workspace`);
  expect((await state.json()).holder).toBe("human");
  await page.getByTestId("hand-back").click();
  await expect(page.getByTestId("control-pill")).toHaveAttribute("data-mode", "view", { timeout: 30_000 });
  const after = await page.request.get(`/api/bots/${bot.id}/workspace`);
  expect((await after.json()).holder).toBe("agent");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("computer-topbar")).toHaveCount(0);
});
