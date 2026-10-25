import { expect, test } from "@playwright/test";
import { login } from "./helpers";

const OPENROUTER = "sk-or-v1-CANARYOPENROUTERKEY8Kx2";

test("approval card describes Always allow and settings can revoke the scoped rule", async ({ page }) => {
  test.setTimeout(180_000);
  await login(page);
  const secret = await page.request.post("/api/secrets", { data: { namespace: "openrouter", name: "default", type: "API_KEY", value: OPENROUTER } });
  expect(secret.ok()).toBeTruthy();
  const created = await page.request.post("/api/bots", { data: { name: `Rules${Date.now().toString().slice(-5)}`, role: "test" } });
  expect(created.ok()).toBeTruthy();
  const bot = await created.json() as { id: string };
  try {
    await page.goto(`/bots/${bot.id}`);
    await page.getByTestId("composer").fill("Open http://portal.example.edu:8099/alpha.html and extract the h1");
    await page.getByTestId("send-chat").click();
    const card = page.getByTestId("approval-card").filter({ has: page.getByRole("button", { name: "Always allow" }) }).first();
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card.getByTestId("approval-always")).toBeVisible();
    await expect(card).toContainText("Always allow portal.example.edu in this bot");
    // Wait for the decision to land before leaving the page, or the navigation can cancel it.
    const decided = page.waitForResponse((r) => /\/api\/approvals\/[^/]+\/decide$/.test(r.url()) && r.request().method() === "POST");
    await card.getByTestId("approval-always").click();
    expect((await decided).ok()).toBeTruthy();

    await page.goto("/settings/approval-rules");
    const row = page.getByTestId("approval-rule").first();
    await expect(row).toBeVisible();
    await expect(row).toContainText("portal.example.edu");
    await expect(row).not.toContainText("All my bots");
    page.once("dialog", (dialog) => dialog.accept());
    await row.getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByTestId("approval-rules-empty")).toBeVisible();
  } finally {
    await page.request.delete(`/api/bots/${bot.id}`);
  }
});

test("never-listed delete approvals do not show Always allow", async ({ page }) => {
  await page.route("**/api/bots/*/workspace", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") return route.continue();
    const data = await route.fetch();
    const body = await data.json();
    body.approvals = [{ id: "never-rule", action: "delete_file", target: "/workspace/notes.txt", status: "pending", riskClass: "delete", summary: "Delete /workspace/notes.txt" }];
    await route.fulfill({ response: data, json: body });
  });
  await login(page);
  const created = await page.request.post("/api/bots", { data: { name: `Never${Date.now().toString().slice(-5)}` } });
  const bot = await created.json() as { id: string };
  try {
    await page.goto(`/bots/${bot.id}`);
    const card = page.getByTestId("approval-card").filter({ hasText: "delete_file" });
    await expect(card).toBeVisible();
    await expect(card.getByTestId("approval-always")).toHaveCount(0);
  } finally { await page.request.delete(`/api/bots/${bot.id}`); }
});
