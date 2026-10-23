import { expect, test } from "@playwright/test";
import { login } from "./helpers";
test("account menu opens About and copies version info", async ({ page }) => {
  await login(page);
  await page.goto("/"); await page.getByTestId("account-button").click(); await page.getByText("Support").hover();
  await page.getByText("About").click(); await expect(page.getByTestId("about-dialog")).toBeVisible();
  await expect(page.getByTestId("copy-version-info")).toBeVisible();
});
