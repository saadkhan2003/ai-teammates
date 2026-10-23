import { expect, test } from "@playwright/test";
import { login } from "./helpers";
test("keyboard shortcuts open their overlays", async ({ page }) => {
  await login(page);
  await page.goto("/");
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+/");
  await expect(page.getByTestId("shortcuts-dialog")).toBeVisible();
});
