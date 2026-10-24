import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const dir = "/opt/cursor/artifacts/surfaces";
const botId = "33333333-3333-4333-8333-333333333333";
const jobId = "44444444-4444-4444-8444-444444444444";
const routineId = "55555555-5555-4555-8555-555555555555";

test.use({ baseURL: process.env.WEB_URL ?? "http://127.0.0.1:13010" });

async function install(page: Page, theme: "light" | "dark") {
  await page.addInitScript(() => {
    const next = new URLSearchParams(location.search).get("theme");
    if (next === "light" || next === "dark" || next === "system") localStorage.setItem("teammates-theme", next);
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path === "/api/events") {
      await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: ": connected\n\n" });
      return;
    }
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/auth/me") return json({ username: "saad", displayName: "Saad Khan", role: "owner", theme, email: "saad@example.com" });
    if (path === "/api/settings/appearance" && method === "PUT") return json({ theme });
    if (path === "/api/devices" && method === "GET") {
      return json([
        { id: "device-1", name: "Studio Mac", os: "macOS", version: "0.4.0", lastSeen: new Date().toISOString(), online: true, execution: "ask", routeTraffic: false, allowFiles: true, allowBrowser: false },
      ]);
    }
    if (path === "/api/devices/version") return json({ latest: "0.4.0", minCompatible: "0.4.0" });
    if (path === "/api/devices/pair" && method === "POST") return json({ code: "481516", expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
    if (path === "/api/usage") return json({ modelCalls: 12, costUsd: 0.42, latencyMs: 180, chromeProcesses: 1, computerMemoryBytes: 256 * 1024 * 1024 });
    if (path === "/api/billing") return json({ planId: "pro", creditBalance: 3200, creditAllowance: 5000, usedCredits: 1800, usedPercent: 36, provider: "mock", chargesCard: false, mockMode: false, renewsAt: "2026-11-01T00:00:00.000Z", plans: [], invoices: [] });
    if (path === "/api/quotas") return json({ bots: 1, maxBots: 5, secrets: 1, maxSecrets: 20, computers: 1, maxComputers: 3 });
    if (path === "/api/admin/usage") return json([{ id: "u1", username: "saad", role: "owner", modelCalls: 12, costUsd: 0.42, latencyMs: 180 }]);
    if (path === "/api/model-requests") return json({ requests: [{ id: "r1", prompt: "Summarize the billing page.", createdAt: "2026-10-24T12:00:00.000Z" }] });
    if (path === "/api/admin/health") return json({ postgres: true, computerIsolation: true, users: 2, computers: 1, stuckTasks: 0 });
    if (path === "/api/admin/outbound-actions") return json({ actions: [{ id: "a1", kind: "send", tool: "email", status: "allowed" }] });
    if (path === "/api/policy") return json({ classes: { read: "ALLOW", write: "ASK", send_message: "ASK", payment: "DENY", sign: "ASK", delete: "DENY", credential_use: "ASK", external_post: "ASK" }, modelAssist: false });
    if (path === "/api/admin/policy/deny-list") return json({ rules: [{ code: "secrets", description: "Never print a raw secret.", builtin: true }] });
    if (path === "/api/secrets") return json([]);
    if (path === "/api/notifications") return json([{ id: "n1", title: "Invite accepted", body: "Ada joined the workspace.", kind: "invite", createdAt: "2026-10-24T12:00:00.000Z" }]);
    if (path === "/api/notifications/read" && method === "POST") return json({ ok: true });
    if (path === "/api/plugins" || path === "/api/plugins/enables") return json([]);
    if (path === "/api/plugins/catalog") return json({ items: [] });
    if (path === "/api/plugins/stats") return json({ installed: 0 });
    if (path === "/api/bots" && method === "GET") return json([{ id: botId, name: "Ada", role: "Engineer", avatarShape: "blob1", avatarColor: "#8eb6ff" }]);
    if (path === `/api/bots/${botId}/workspace`) {
      return json({
        bot: { id: botId, name: "Ada", role: "Engineer", instructions: "Keep the billing page honest.", status: "idle", notificationsEnabled: true },
        codingJobs: [{ id: jobId, title: "UI batch", status: "running", step: "Editing the composer", branch: "ui-batch", filesChanged: 4, additions: 20, deletions: 3, prNumber: 11, prUrl: "https://example.com/pull/11" }],
      });
    }
    if (path === `/api/bots/${botId}/routines`) {
      return json([{ id: routineId, name: "Morning brief", cron: "0 8 * * 1-5", instruction: "Summarize overnight work.", nextRunAt: "2026-10-27T08:00:00.000Z", enabled: true }]);
    }
    if (path === `/api/bots/${botId}/coding-jobs/${jobId}`) {
      return json({ id: jobId, title: "UI batch", status: "running", step: "Editing the composer", branch: "ui-batch", filesChanged: 4, additions: 20, deletions: 3, prNumber: 11, prUrl: "https://example.com/pull/11" });
    }
    if (path === `/api/bots/${botId}` && method === "PATCH") return json({ id: botId, name: "Ada" });
    if (path === "/api/feedback" && method === "POST") return json({ ok: true });
    return json([]);
  });
}

const shots: [string, string, string][] = [
  ["general", "/settings", "settings-modal"],
  ["policy", "/settings/policy", "settings-modal"],
  ["computer", "/settings/computer", "settings-computer"],
  ["updates", "/settings/updates", "updates-card"],
  ["notifications", "/settings/notifications", "settings-notifications"],
  ["usage", "/settings/usage", "usage-report"],
  ["vault", "/settings/secrets", "settings-vault"],
  ["plugins", "/settings/plugins", "settings-modal"],
  ["system", "/system", "admin-health"],
  ["login", "/login", "login-card"],
  ["invite", "/invite", "invite-card"],
  ["reset", "/login/reset", "reset-page"],
  ["offline", "/offline", "offline-page"],
  ["not-found", "/missing-screen", "not-found-page"],
  ["error", "/dev/error-screen", "error-page"],
  ["teammate", `/bots/${botId}/settings`, "teammate-settings-page"],
  ["routines", `/bots/${botId}/routines`, "routines-page"],
  ["routine", `/bots/${botId}/routines/${routineId}`, "routine-page"],
  ["jobs", `/bots/${botId}/jobs`, "coding-jobs-page"],
  ["job", `/bots/${botId}/jobs/${jobId}`, "coding-job-page"],
];

test("settings, jobs, and auth screens render in light and dark", async ({ page }) => {
  mkdirSync(dir, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1100 });
  for (const theme of ["light", "dark"] as const) {
    await install(page, theme);
    await page.emulateMedia({ colorScheme: theme });
    for (const [name, href, testId] of shots) {
      await page.goto(`${href}?theme=${theme}`);
      const target = page.getByTestId(testId).first();
      await expect(target).toBeVisible({ timeout: 60_000 });
      if (name === "general") await expect(page.getByRole("heading", { name: "General" })).toBeVisible();
      if (name === "policy") await expect(page.getByText("Action rules")).toBeVisible();
      if (name === "computer") await expect(page.getByTestId("device-version")).toContainText("Latest companion");
      if (name === "vault") await expect(page.getByRole("heading", { name: "Vault" })).toBeVisible();
      if (name === "job") await expect(page.getByRole("heading", { name: "UI batch" })).toBeVisible();
      await expect(page.getByText(/mock mode|MOCK/i)).toHaveCount(0);
      await expect(page.locator("body")).not.toContainText(/haiku|claude|anthropic|openrouter|\bgpt\b/i);
      await target.screenshot({ path: `${dir}/${theme}-${name}.png` });
    }
    await page.goto(`/?theme=${theme}`);
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await page.getByTestId("command-palette").screenshot({ path: `${dir}/${theme}-command.png` });
    await page.keyboard.press("Escape");
    await page.getByTestId("account-button").click();
    await page.getByRole("menuitem", { name: "Support" }).hover();
    await page.getByTestId("send-feedback").click();
    await expect(page.getByTestId("feedback-dialog")).toBeVisible();
    await page.getByTestId("feedback-dialog").screenshot({ path: `${dir}/${theme}-feedback.png` });
    await page.keyboard.press("Escape");
  }
});
