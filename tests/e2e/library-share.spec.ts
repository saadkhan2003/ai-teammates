import { expect, test } from "@playwright/test";

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
  }
  expect(bot?.id).toBeTruthy();
  return bot as { id: string; name: string };
}

test("library and share controls are available in the bot panel", async ({ page }) => {
  const bot = await firstBot(page);
  await page.goto(`/bots/${bot.id}`);
  await expect(page.getByTestId("bot-name-button")).toBeVisible();
  if ((await page.getByTestId("bot-name-button").getAttribute("aria-expanded")) !== "true") await page.getByTestId("bot-name-button").click();
  await expect(page.getByTestId("info-pane")).toBeVisible();
  await page.getByRole("button", { name: "Share bot" }).click();
  await expect(page.getByRole("menuitem", { name: "Create a copy" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Share a template link" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "Library" }).click();
  await expect(page.getByText(/Nothing here yet|Loading library|Today|Yesterday/).first()).toBeVisible();
});
