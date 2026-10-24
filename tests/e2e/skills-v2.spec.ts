import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test("owner can view a guide skill in the bot Skills pane", async ({ page }) => {
  await login(page);
  const response = await page.request.post("/api/bots", { data: { name: `Skill ${Date.now()}` } });
  expect(response.ok()).toBeTruthy();
  const bot = await response.json() as { id: string };
  try {
    await page.request.post(`/api/bots/${bot.id}/skill-library`, { data: { name: "daily-review", title: "Daily review", whenToUse: "When reviewing the queue", body: "# Review\nCheck the newest orders." } });
    await page.goto(`/bots/${bot.id}`);
    await page.getByRole("tab", { name: /skills/i }).click();
    await expect(page.getByText("When reviewing the queue")).toBeVisible();
    await page.getByRole("button", { name: "View" }).click();
    await expect(page.getByText("Check the newest orders.")).toBeVisible();
  } finally {
    await page.request.delete(`/api/bots/${bot.id}`);
  }
});
