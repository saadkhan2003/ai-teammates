import { expect, test } from "@playwright/test";
import { login } from "./helpers";
test("settings routes render in the settings modal", async ({ page }) => {
  await login(page);
  await page.goto("/settings/computer"); await expect(page.getByTestId("settings-modal")).toBeVisible();
  await expect(page.getByTestId("settings-computer")).toBeVisible();
});
