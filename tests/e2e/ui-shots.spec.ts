import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Captures the computer view and the usage page in light and dark for the report.
// SHOT_DIR and SHOT_LABEL (before|after) choose where files go; skipped without SHOT_DIR.
const dir = process.env.SHOT_DIR;
const label = process.env.SHOT_LABEL ?? "after";

async function firstBot(page: Page) {
  const raw = await (await page.request.get("/api/bots")).json();
  const list = (Array.isArray(raw) ? raw : raw.bots) as { id: string; name: string }[];
  if (list.length) return list[0];
  const made = await page.request.post("/api/bots", { data: { name: "Ava" } });
  expect(made.ok()).toBeTruthy();
  const body = await made.json();
  return (body.bot ?? body) as { id: string; name: string };
}

async function theme(page: Page, mode: "light" | "dark") {
  await page.addInitScript((value) => localStorage.setItem("teammates-theme", value), mode);
}

for (const mode of ["light", "dark"] as const) {
  test(`ui shots ${mode}`, async ({ page }) => {
    test.skip(!dir, "SHOT_DIR not set");
    fs.mkdirSync(dir!, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await theme(page, mode);
    const bot = await firstBot(page);
    await page.goto(`/bots/${bot.id}`);
    await expect(page.getByTestId("bot-name-button")).toBeVisible();
    if ((await page.getByTestId("bot-name-button").getAttribute("aria-expanded")) !== "true") await page.getByTestId("bot-name-button").click();
    await expect(page.getByTestId("desktop-frame")).toBeVisible();
    await page.getByTestId("desktop-frame").click();
    await expect(page.getByTestId("computer-topbar")).toBeVisible();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(dir!, `computer-view-${label}-${mode}.png`) });
    await page.goto("/settings/usage");
    await page.getByText(/Weekly usage limit|Model calls/).first().waitFor({ timeout: 20_000 }).catch(() => undefined);
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(dir!, `usage-${label}-${mode}.png`), fullPage: true });
  });
}
