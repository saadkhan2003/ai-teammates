import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";

test.use({ baseURL: process.env.ADMIN_URL, storageState: { cookies: [], origins: [] } });
test.skip(!process.env.ADMIN_URL, "ADMIN_URL is required for the separate admin listener.");

test("owner configures a mock provider, saves and rolls back with theme evidence", async ({ page }) => {
  await page.goto("/login");
  await page.getByTestId("admin-username").fill(process.env.OWNER_USERNAME ?? "saad");
  await page.getByTestId("admin-password").fill(process.env.OWNER_PASSWORD ?? "teammates-dev");
  await page.getByTestId("admin-submit").click();
  await expect(page.getByTestId("admin-nav")).toBeVisible();
  const original = await page.request.get("/api/admin/ai").then(r => r.json());
  const name = `Browser mock ${Date.now()}`;
  let savedVersion: number | undefined;
  let providerId: string | undefined;
  try {
    await page.getByRole("link", { name: "AI models", exact: true }).click();
    await page.getByRole("button", { name: "Add provider", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Provider name", { exact: true }).fill(name);
    await dialog.getByRole("combobox", { name: "Kind", exact: true }).selectOption("mock");
    await dialog.getByLabel("Base URL", { exact: true }).fill("http://mock-openrouter:8090/p2/v1");
    await dialog.getByLabel("API key", { exact: true }).fill("sk-or-browser-mock-only-000000");
    await dialog.getByLabel("id", { exact: true }).fill("mock/planner");
    await dialog.getByLabel("vision", { exact: true }).check();
    await dialog.getByRole("button", { name: "Save provider", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await page.getByRole("button", { name: `Test ${name}`, exact: true }).click();
    await expect(page.getByRole("row").filter({ hasText: name })).toContainText("Connected");
    const metadata = await page.request.get("/api/admin/ai").then(r => r.json());
    providerId = metadata.providers.find((p: { name: string }) => p.name === name).id;
    const target = `${providerId}|mock/planner`;
    for (const label of ["Chat / planner", "Quick / acknowledgements and titles", "Vision", "Coding"]) {
      await page.getByLabel(`${label} primary`, { exact: true }).selectOption(target);
    }
    await page.getByLabel("Version note", { exact: true }).fill("Browser mock config");
    await page.getByRole("button", { name: "Save configuration", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Configuration saved." })).toBeVisible();
    const versions = await page.request.get("/api/admin/ai/versions").then(r => r.json());
    savedVersion = versions[0].version;
    for (const heading of ["Overview", "Providers & keys", "Roles", "Catalog", "Rollout", "Evals", "Budgets", "Health", "Audit log"]) await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await page.getByRole("button", { name: `Run eval ${savedVersion}`, exact: true }).click();
    await expect(page.getByRole("button", { name: `Run eval ${savedVersion}`, exact: true })).toBeEnabled();
    // An isolated stack may have no legacy bootstrap key. Explicit owner override is audited.
    await page.getByLabel("Owner override reason (optional)", { exact: true }).fill("Browser fixture explicit owner approval");
    await page.getByRole("button", { name: `Publish ${savedVersion}`, exact: true }).click();
    await expect.poll(async () => (await page.request.get("/api/admin/ai").then(r => r.json())).version).toBe(savedVersion);
    expect(savedVersion!).toBeGreaterThan(original.version);
    const rollbackTarget = original.version || savedVersion;
    await page.getByRole("button", { name: `Rollback to ${rollbackTarget}`, exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Rollback saved" })).toBeVisible();
    const after = await page.request.get("/api/admin/ai").then(r => r.json());
    expect(after.version).toBe(rollbackTarget);
    expect(after.active_config.roles.chat.primary.provider).toBe(original.active_config?.roles.chat.primary.provider ?? providerId);
    if (process.env.SHOT_DIR) {
      mkdirSync(process.env.SHOT_DIR, { recursive: true });
      for (const theme of ["light", "dark"]) {
        await page.getByTestId(`admin-theme-${theme}`).click();
        await page.screenshot({ path: `${process.env.SHOT_DIR}/admin-ai-models-${theme}.png`, fullPage: true });
      }
      await page.getByRole("link", { name: "Speed", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Speed", exact: true })).toBeVisible();
      await expect(page.getByText("Loading metrics…")).toHaveCount(0);
      for (const theme of ["light", "dark"]) {
        await page.getByTestId(`admin-theme-${theme}`).click();
        await page.screenshot({ path: `${process.env.SHOT_DIR}/admin-speed-${theme}.png`, fullPage: true });
      }
    }
  } finally {
    if (original.version) {
      await page.request.post(`/api/admin/ai/versions/${original.version}/rollback`);
      if (providerId) await page.request.delete(`/api/admin/ai/providers/${providerId}`);
    }
    // With env bootstrap there is no persisted version to restore; retain the test mock config.
  }
});
