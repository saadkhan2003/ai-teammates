import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test("plugins settings search and empty state", async ({ page }, testInfo) => {
  await login(page);
  await page.goto("/settings/plugins");
  await expect(page.getByRole("heading", { name: "Plugins" })).toBeVisible();
  await expect(page.getByTestId("plugins-pane")).toBeVisible();
  await expect(page.getByTestId("plugins-loading")).toHaveCount(0);
  await expect(page.getByTestId("plugin-stats")).toBeVisible();
  const stats = await page.getByTestId("plugin-stats").innerText();
  expect(stats).toMatch(/Imported \d+/);
  expect(stats).toMatch(/Auto-checked \d+/);
  expect(stats).not.toMatch(/Imported 6000/);
  await page.getByLabel("Search plugins").fill("zzz-no-such-plugin-9911");
  await expect(page.getByTestId("plugins-empty")).toBeVisible();
  const dir = "/opt/cursor/artifacts/screenshots";
  fs.mkdirSync(dir, { recursive: true });
  const name = testInfo.project.name.includes("iphone") ? "plugins-iphone-13" : "plugins-desktop";
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
  fs.mkdirSync("/workspace/docs/evidence", { recursive: true });
  fs.copyFileSync(`${dir}/${name}.png`, `/workspace/docs/evidence/${name}.png`);
});
