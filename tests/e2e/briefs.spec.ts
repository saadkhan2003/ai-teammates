import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test("task brief collapses, expands, changes theme, and accepts steering", async ({ page }) => {
  await login(page);
  const created = await page.request.post("/api/bots", { data: { name: `Brief ${Date.now().toString().slice(-5)}`, role: "Teammate", instructions: "" } });
  expect(created.ok()).toBeTruthy();
  const bot = await created.json() as { id: string };
  try {
    const workspaceResponse = await page.request.get(`/api/bots/${bot.id}/workspace`);
    expect(workspaceResponse.ok()).toBeTruthy();
    const workspace = await workspaceResponse.json() as { conversationId?: string };
    const seeded = await page.request.post("/api/test/briefs/seed", { data: { botId: bot.id, conversationId: workspace.conversationId } });
    if (seeded.status() === 404) test.skip(true, "Task brief seed hook is unavailable on this stack.");
    expect(seeded.ok(), `seed brief returned ${seeded.status()}`).toBeTruthy();

    await page.goto(`/bots/${bot.id}`);
    const card = page.getByTestId("brief-card");
    await expect(card).toBeVisible();
    const toggle = card.getByTestId("brief-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("brief-thought")).toBeVisible();

    const shotDir = process.env.SHOT_DIR;
    if (shotDir) {
      fs.mkdirSync(shotDir, { recursive: true });
      await card.screenshot({ path: path.join(shotDir, "brief-collapsed-dark.png") });
    }
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    if (shotDir) await card.screenshot({ path: path.join(shotDir, "brief-expanded-dark.png") });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    await page.evaluate(() => {
      localStorage.setItem("teammates-theme", "light");
      document.documentElement.classList.add("light");
      document.documentElement.dataset.theme = "light";
    });
    await expect(page.locator("html")).toHaveClass(/light/);
    if (shotDir) await card.screenshot({ path: path.join(shotDir, "brief-collapsed-light.png") });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    if (shotDir) await card.screenshot({ path: path.join(shotDir, "brief-expanded-light.png") });

    await card.getByTestId("brief-steer").click();
    await card.getByTestId("brief-steer-input").fill("Keep the implementation focused on the existing API.");
    await card.getByTestId("brief-steer-send").click();
    await expect(card.getByTestId("brief-steering-item")).toContainText("Keep the implementation focused on the existing API.");
  } finally {
    await page.request.delete(`/api/bots/${bot.id}`);
  }
});
