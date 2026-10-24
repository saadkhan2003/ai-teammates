import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test("owner can view, review, revert, and archive guide skills in the bot Skills pane", async ({ page }) => {
  await login(page);
  const response = await page.request.post("/api/bots", { data: { name: `Skill ${Date.now()}` } });
  expect(response.ok()).toBeTruthy();
  const bot = await response.json() as { id: string };
  try {
    const created = await page.request.post(`/api/bots/${bot.id}/skill-library`, { data: { name: "daily-review", title: "Daily review", whenToUse: "When reviewing the queue", body: "# Review\nCheck the newest orders." } });
    const skill = await created.json() as { id: string };
    await page.request.put(`/api/skill-library/${skill.id}`, { data: { name: "daily-review", title: "Daily review", whenToUse: "When reviewing the queue", body: "# Review\nConfirm the queue totals." } });
    await page.goto(`/bots/${bot.id}`);
    await page.getByRole("tab", { name: /skills/i }).click();
    await expect(page.getByText("When reviewing the queue")).toBeVisible();
    const row = page.getByTestId("skill-list").locator("li").filter({ hasText: "daily-review" });
    await row.getByRole("button", { name: "View" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Confirm the queue totals.")).toBeVisible();
    await expect(dialog.getByText("Revision history")).toBeVisible();
    await expect(dialog.getByText("Check the newest orders.")).toBeVisible();
    await dialog.getByRole("button", { name: "Revert" }).click();
    await expect(dialog.getByRole("heading", { name: /Daily review · v3/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await row.getByRole("button", { name: "Archive" }).click();
    await expect(page.getByText("daily-review")).toHaveCount(0);
    const builtins = await page.request.get(`/api/bots/${bot.id}/skill-library`).then(r => r.json()) as Array<{ id: string; name: string; title: string; when_to_use: string; body?: string }>;
    const builtin = builtins.find(item => item.name === "research");
    expect(builtin).toBeTruthy();
    const denied = await page.request.put(`/api/skill-library/${builtin!.id}`, { data: { name: builtin!.name, title: builtin!.title, whenToUse: builtin!.when_to_use, body: "mutate" } });
    expect(denied.status()).toBe(403);
    const notArchived = await page.request.post(`/api/skill-library/${builtin!.id}/archive`);
    expect(notArchived.status()).toBe(404);
  } finally {
    await page.request.delete(`/api/bots/${bot.id}`);
  }
});
