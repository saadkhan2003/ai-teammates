import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";

test.use({ baseURL: process.env.ADMIN_URL, storageState: { cookies: [], origins: [] } });
test.skip(!process.env.ADMIN_URL, "ADMIN_URL is required for the separate admin listener.");

test("admin edits plan allowance and sees the per-user AI / computer / storage breakdown", async ({ page }) => {
  await page.goto("/login");
  await page.getByTestId("admin-username").fill(process.env.OWNER_USERNAME ?? "saad");
  await page.getByTestId("admin-password").fill(process.env.OWNER_PASSWORD ?? "teammates-dev");
  await page.getByTestId("admin-submit").click();
  await expect(page.getByTestId("admin-nav")).toBeVisible();
  const original = await page.request.get("/api/admin/billing").then(r => r.json());
  const pro = original.plans.find((p: { id: string }) => p.id === "pro");
  try {
    await page.getByRole("link", { name: "Billing", exact: true }).click();
    await expect(page.getByTestId("billing-usage")).toBeVisible();
    const header = page.getByTestId("billing-usage").locator("thead");
    for (const col of ["AI", "Computer", "Storage"]) await expect(header).toContainText(col);
    expect(await page.getByTestId("billing-user").count()).toBeGreaterThan(0);
    for (const col of ["Disk", "RAM"]) await expect(header).toContainText(col);
    await expect(page.getByTestId("billing-user-storage").first()).toContainText("GB");
    const resources = page.getByTestId("billing-resources");
    await expect(resources).toContainText("Shared base image");
    await expect(page.getByTestId("billing-base-image")).not.toBeEmpty();
    expect(Number(await page.getByTestId("billing-max-computers").innerText())).toBeGreaterThan(3);
    await page.getByTestId("billing-run-cleanup").click();
    await expect(page.getByRole("status").filter({ hasText: /Cleanup removed \d+ files/ })).toBeVisible();
    await expect(page.getByTestId("billing-last-cleanup")).toContainText("Last cleanup (admin)");
    await expect(page.getByTestId("billing-run-cleanup")).toBeEnabled();
    await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
    const standard = original.plans.find((p: { id: string }) => p.id === "standard");
    expect(standard.storageQuotaGb).toBe(50);
    expect(standard.ramMb).toBe(8192);
    expect([standard.cpuMinCores, standard.cpuMaxCores]).toEqual([1, 2]);
    await page.getByLabel("Pro Storage quota (GB)", { exact: true }).fill(String(pro.storageQuotaGb + 1));
    const field = page.getByLabel("Pro Weekly credits", { exact: true });
    await field.fill(String(pro.weeklyCredits + 1));
    await expect(field).toHaveValue(String(pro.weeklyCredits + 1));
    await expect(page.getByLabel("Pro Storage quota (GB)", { exact: true })).toHaveValue(String(pro.storageQuotaGb + 1));
    await page.getByTestId("save-plan-pro").click();
    await expect(page.getByRole("status").filter({ hasText: "Pro saved." })).toBeVisible();
    const after = await page.request.get("/api/admin/billing").then(r => r.json());
    expect(after.plans.find((p: { id: string }) => p.id === "pro").weeklyCredits).toBe(pro.weeklyCredits + 1);
    expect(after.plans.find((p: { id: string }) => p.id === "pro").storageQuotaGb).toBe(pro.storageQuotaGb + 1);
    if (process.env.SHOT_DIR) {
      mkdirSync(process.env.SHOT_DIR, { recursive: true });
      for (const theme of ["light", "dark"]) {
        await page.getByTestId(`admin-theme-${theme}`).click();
        await page.screenshot({ path: `${process.env.SHOT_DIR}/admin-billing-${theme}.png`, fullPage: true });
      }
    }
  } finally {
    await page.request.put("/api/admin/billing/plans/pro", { data: { weeklyCredits: pro.weeklyCredits, storageQuotaGb: pro.storageQuotaGb } });
  }
});
