import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { login } from "./helpers";

const shotDir = "/workspace/shots-skills-v2";
async function screenshot(page: import("@playwright/test").Page, screen: string, mode: "light" | "dark") {
  const stableScreen = screen.replace(/-(light|dark)$/, "");
  await page.evaluate((theme) => {
    localStorage.setItem("teammates-theme", theme);
    document.documentElement.classList.toggle("light", theme === "light");
    document.documentElement.dataset.theme = theme;
  }, mode);
  await page.evaluate(async () => {
    await document.fonts.ready;
    const finiteAnimations = document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity);
    await Promise.race([
      Promise.all(finiteAnimations.map((animation) => animation.finished.catch(() => undefined))),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await page.screenshot({ path: `${shotDir}/02-${stableScreen}-${mode}.png`, fullPage: false });
}

test("owner can view, review, revert, and archive guide skills in the bot Skills pane", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  const response = await page.request.post("/api/bots", { data: { name: `Skill ${Date.now()}` } });
  expect(response.ok()).toBeTruthy();
  const bot = await response.json() as { id: string };
  // The skill library is owner-wide and outlives the bot, so use a per-run slug and archive it on the way out.
  const slug = `daily-review-${randomUUID()}`;
  let skillId: string | undefined;
  try {
    const created = await page.request.post(`/api/bots/${bot.id}/skill-library`, { data: { name: slug, title: "Daily review", whenToUse: "When reviewing the queue", body: "# Review\nCheck the newest orders." } });
    const skill = await created.json() as { id: string };
    skillId = skill.id;
    await page.request.put(`/api/skill-library/${skill.id}`, { data: { name: slug, title: "Daily review", whenToUse: "When reviewing the queue", body: "# Review\nConfirm the queue totals." } });
    await page.goto(`/bots/${bot.id}`);
    await page.getByRole("tab", { name: /skills/i }).click();
    await expect(page.getByText("When reviewing the queue")).toBeVisible();
    await screenshot(page, "skills-pane-list", "dark");
    await screenshot(page, "skills-pane-list", "light");
    const row = page.getByTestId("skill-list").locator("li").filter({ hasText: slug });
    await row.getByRole("button", { name: "View" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Confirm the queue totals.")).toBeVisible();
    await expect(dialog.getByText("Revision history")).toBeVisible();
    await expect(dialog.getByText("Check the newest orders.")).toBeVisible();
    await screenshot(page, "skills-pane-history", "light");
    await screenshot(page, "skills-pane-history", "dark");
    await dialog.getByRole("button", { name: "Revert" }).click();
    await expect(dialog.getByRole("heading", { name: /Daily review, version 3/ })).toBeVisible();
    await screenshot(page, "skills-pane-reverted", "dark");
    await screenshot(page, "skills-pane-reverted", "light");
    await page.keyboard.press("Escape");
    await row.getByRole("button", { name: "Archive" }).click();
    await expect(page.getByText(slug)).toHaveCount(0);
    const builtins = await page.request.get(`/api/bots/${bot.id}/skill-library`).then(r => r.json()) as Array<{ id: string; name: string; title: string; whenToUse: string; body?: string }>;
    const builtin = builtins.find(item => item.name === "research");
    expect(builtin).toBeTruthy();
    const denied = await page.request.put(`/api/skill-library/${builtin!.id}`, { data: { name: builtin!.name, title: builtin!.title, whenToUse: builtin!.whenToUse, body: "mutate" } });
    expect(denied.status()).toBe(403);
    const notArchived = await page.request.post(`/api/skill-library/${builtin!.id}/archive`);
    expect(notArchived.status()).toBe(404);
  } finally {
    if (skillId) await page.request.post(`/api/skill-library/${skillId}/archive`);
    await page.request.delete(`/api/bots/${bot.id}`);
  }
});
