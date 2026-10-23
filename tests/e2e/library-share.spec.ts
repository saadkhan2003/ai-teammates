import { expect, test } from "@playwright/test";
import { loginAsOwner, openFirstBot } from "./helpers";

test("library and share controls are available in the bot panel", async ({ page }) => {
  await loginAsOwner(page);
  await openFirstBot(page);
  await page.getByTestId("bot-name-button").click();
  await expect(page.getByTestId("info-pane")).toBeVisible();
  await page.getByRole("button", { name: "Share bot" }).click();
  await expect(page.getByRole("menuitem", { name: "Create a copy" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Share a template link" })).toBeVisible();
  await page.getByRole("tab", { name: "Library" }).click();
  await expect(page.getByText(/Nothing here yet|Loading library|Today|Yesterday/).first()).toBeVisible();
});
