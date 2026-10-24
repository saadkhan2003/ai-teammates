import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test("create bot dialog selects a live avatar and submits with Enter", async ({ page }) => {
  await login(page);
  await page.evaluate(() => window.dispatchEvent(new Event("teammates-open-create")));
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Create New Bot")).toBeVisible();
  await expect(dialog.getByTestId("bot-create")).toBeDisabled();
  await expect(dialog.locator("[data-testid^='avatar-shape-']")).toHaveCount(15);
  await expect(dialog.locator("[data-testid^='avatar-color-']")).toHaveCount(14);
  await dialog.getByTestId("avatar-shape-blob8").click();
  await dialog.getByTestId("avatar-color-purple").click();
  const name = `Avatar bot ${Date.now()}`;
  await dialog.getByTestId("bot-name").fill(name);
  const responsePromise = page.waitForResponse(response => response.url().endsWith("/api/bots") && response.request().method() === "POST");
  await dialog.getByTestId("bot-name").press("Enter");
  const response = await responsePromise;
  const bot = await response.json();
  try {
    expect(response.ok()).toBeTruthy();
    expect(bot.avatarShape).toBe("blob8");
    expect(bot.avatarColor).toBe("#8b5cf6");
    await expect(dialog).toHaveCount(0);
  } finally {
    if (bot.id) await page.request.delete(`/api/bots/${bot.id}`);
  }
});
