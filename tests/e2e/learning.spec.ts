import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test("owner reactions teach a private note, with source navigation and deletion at 375px", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page);
  const created = await page.request.post("/api/bots", { data: { name: `Learn ${Date.now().toString().slice(-6)}`, role: "Teammate", instructions: "" } });
  expect(created.ok()).toBeTruthy();
  const bot = await created.json() as { id: string };
  try {
    const workspace = await (await page.request.get(`/api/bots/${bot.id}/workspace`)).json() as { conversationId: string };
    // Reuse the existing brief fixture to get a bot result without requiring paid models or a new hook.
    const seeded = await page.request.post("/api/test/briefs/seed", { data: { botId: bot.id, conversationId: workspace.conversationId } });
    expect(seeded.ok(), "The isolated mock stack must enable existing test fixtures").toBeTruthy();
    const source = await seeded.json() as { messageId: string };
    await page.goto(`/bots/${bot.id}`);
    const message = page.locator(`[data-message-id="${source.messageId}"]`);
    await expect(message).toBeVisible();
    await message.click();
    await message.getByTestId("msg-react").click();
    await page.getByTestId("quick-👍").click();
    await page.getByTestId("bot-name-button").click();
    const section = page.getByTestId("learned-section");
    await expect(section.getByTestId("learned-item")).toHaveCount(1, { timeout: 40_000 });
    await section.scrollIntoViewIfNeeded();
    await expect(section).toContainText("Quality bar");
    await expect(section).toContainText("from your 👍");
    const shots = process.env.SHOT_DIR;
    if (shots) fs.mkdirSync(shots, { recursive: true });
    await page.evaluate(() => { document.documentElement.classList.remove("light"); document.documentElement.dataset.theme = "dark"; });
    if (shots) await section.screenshot({ path: path.join(shots, "learned-dark.png") });
    await page.evaluate(() => { document.documentElement.classList.add("light"); document.documentElement.dataset.theme = "light"; });
    if (shots) await section.screenshot({ path: path.join(shots, "learned-light.png") });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await section.getByRole("button", { name: /from your 👍/ }).click();
    await expect(message).toBeVisible();
    await page.getByTestId("bot-name-button").click();
    await section.getByTestId("learned-delete").click();
    const confirm = page.getByRole("dialog", { name: "Delete this learned note?" });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Delete note", exact: true }).click();
    await expect(section.getByTestId("learned-item")).toHaveCount(0);
    await expect(section).toContainText("Nothing learned yet");
    const learned = await page.request.get(`/api/bots/${bot.id}/learned`);
    expect(await learned.json()).toEqual([]);
  } finally { await page.request.delete(`/api/bots/${bot.id}`); }
});
