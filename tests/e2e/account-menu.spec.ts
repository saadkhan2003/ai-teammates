import { expect, test } from "@playwright/test";
import { login } from "./helpers";
test("account support opens feedback dialog", async ({ page }) => {
  await login(page);
  await page.goto("/"); await page.getByTestId("account-button").click();
  await page.getByText("Support").hover(); await page.getByTestId("send-feedback").click();
  await expect(page.getByTestId("feedback-dialog")).toBeVisible();
});
