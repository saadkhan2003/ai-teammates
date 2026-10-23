import { expect, test } from "@playwright/test";
test("account support opens feedback dialog", async ({ page }) => {
  await page.goto("/"); await page.getByTestId("account-button").click();
  await page.getByText("Support").hover(); await page.getByTestId("send-feedback").click();
  await expect(page.getByTestId("feedback-dialog")).toBeVisible();
});
