import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test("name alone creates a teammate and empty names get inline validation", async ({ page }) => {
  await login(page);
  await page.evaluate(() => window.dispatchEvent(new Event("teammates-open-create")));
  await expect(page.getByTestId("create-bot-title")).toHaveText("Create New Bot");
  await expect(page.getByTestId("avatar-picker")).toBeVisible();
  await expect(page.getByTestId("bot-create")).toBeDisabled();
  await expect(page.getByTestId("bot-name")).toBeVisible();
  const name = `Name only ${Date.now()}`;
  await page.getByTestId("bot-name").fill(name);
  const created = page.waitForResponse(response => response.url().endsWith("/api/bots") && response.request().method() === "POST");
  await page.getByTestId("avatar-shape-blob4").click();
  await page.getByTestId("avatar-color-teal").click();
  await page.getByTestId("bot-create").click();
  const response = await created;
  const bot = await response.json();
  try {
    expect(response.ok(), "create name-only teammate").toBeTruthy();
    expect(bot.role).toBe("Teammate");
    expect(bot.avatarShape).toBe("blob4");
    expect(bot.avatarColor).toBe("#14b8a6");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } finally { if (bot.id) await page.request.delete(`/api/bots/${bot.id}`); }
});
