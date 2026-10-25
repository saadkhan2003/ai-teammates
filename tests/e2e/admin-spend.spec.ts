import { expect, test } from "@playwright/test";

test.use({ baseURL: process.env.ADMIN_URL, storageState: { cookies: [], origins: [] } });
test.skip(!process.env.ADMIN_URL || !process.env.OWNER_USERNAME || !process.env.OWNER_PASSWORD, "ADMIN_URL, OWNER_USERNAME, and OWNER_PASSWORD are required for the separate admin listener.");

test("shows spend caps in a readable table", async ({ page }) => {
  const ownerId = "11111111-1111-4111-8111-111111111111";
  const botId = "22222222-2222-4222-8222-222222222222";
  const providerId = "33333333-3333-4333-8333-333333333333";
  await page.route("**/api/admin/ai/spend?*", route => route.fulfill({ json: {
    owners: [], total: { today: 0, month: 0 }, page: 1, page_size: 10, total_owners: 0,
    caps: {
      plans: { default: { daily: 10, monthly: 100, action: "block" } },
      users: { [ownerId]: { daily: 5, action: "block" } },
      bots: { [botId]: { monthly: 20, action: "downgrade", downgrade: { provider: providerId, model: "mock/cheap" } } },
    },
  } }));
  await page.goto("/login");
  await page.getByTestId("admin-username").fill(process.env.OWNER_USERNAME!);
  await page.getByTestId("admin-password").fill(process.env.OWNER_PASSWORD!);
  await page.getByTestId("admin-submit").click();
  await expect(page.getByTestId("admin-nav")).toBeVisible();
  await page.getByRole("link", { name: "AI models", exact: true }).click();

  const caps = page.getByRole("region", { name: "Spending caps" });
  await expect(caps.getByRole("heading", { name: "Configured caps" })).toBeVisible();
  await expect(caps.getByText("Plan: default")).toBeVisible();
  await expect(caps.getByText("$10.000000")).toBeVisible();
  await expect(caps.getByText("$100.000000")).toBeVisible();
  await expect(caps.getByText("$5.000000")).toBeVisible();
  await expect(caps.getByText("$20.000000")).toBeVisible();
  await expect(caps.getByText("downgrade", { exact: true })).toBeVisible();
  await expect(caps.getByText("mock/cheap")).toBeVisible();
  await expect(caps.getByRole("button", { name: "Copy owner ID" })).toBeVisible();
  await expect(caps.getByRole("button", { name: "Copy bot ID" })).toBeVisible();
  await expect(caps.locator("pre")).toHaveCount(0);
});
