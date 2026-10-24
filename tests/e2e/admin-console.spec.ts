import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const dir = "/opt/cursor/artifacts/admin-console";

const sections = [
  ["/", "overview"],
  ["/users", "users"],
  ["/bots", "bots"],
  ["/computers", "computers"],
  ["/plans", "plans"],
  ["/billing", "billing"],
  ["/models", "models"],
  ["/storage", "storage"],
  ["/plugins", "plugins"],
  ["/flags", "flags"],
  ["/announcements", "announcements"],
  ["/support", "support"],
  ["/security", "security"],
  ["/health", "health"],
  ["/settings", "settings"],
] as const;

function fresh() {
  return { role: "owner", signedIn: false, impersonating: false };
}

function staff(role: string) {
  return role === "owner" || role === "admin" || role === "support" || role === "readonly";
}

async function install(page: Page, state: ReturnType<typeof fresh>) {
  await page.addInitScript(() => {
    const theme = new URLSearchParams(location.search).get("theme");
    if (theme === "light" || theme === "dark" || theme === "system") localStorage.setItem("teammates-admin-theme", theme);
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/auth/login" && method === "POST") {
      const body = request.postDataJSON() as { username?: string };
      state.role = body.username === "readonly" ? "readonly" : body.username === "support" ? "support" : body.username === "member" ? "member" : "owner";
      state.signedIn = state.role !== "member";
      if (body.username === "member") return json({ error: "unauthorized" }, 401);
      return json({ username: body.username });
    }
    if (path === "/api/auth/logout") {
      state.signedIn = false;
      return json({ ok: true });
    }
    if (path === "/api/auth/me") {
      if (!state.signedIn) return json({ error: "unauthorized" }, 401);
      return json({ username: state.role, role: state.role, theme: "system" });
    }
    if (path === "/api/settings/appearance") return json({ theme: "system" });
    if (!state.signedIn) return json({ error: "unauthorized" }, 401);
    if (!staff(state.role)) return json({ error: "forbidden" }, 403);
    if (path === "/api/admin/console/session") {
      return json({
        role: state.role,
        totpRequired: state.role === "owner" || state.role === "admin",
        totpEnrolled: true,
        maintenance: { enabled: false, message: "" },
        impersonation: state.impersonating ? { username: "ada", displayName: "Ada Lovelace" } : null,
      });
    }
    if (path === "/api/admin/console/impersonate" && method === "POST") {
      state.impersonating = true;
      return json({ id: "imp", username: "ada" });
    }
    if (path === "/api/admin/console/impersonate/end") {
      state.impersonating = false;
      return json({ ok: true });
    }
    if (path === "/api/admin/accounts") {
      return json({
        runtimeProvider: "mock",
        modelId: "anthropic/claude-haiku-5.5",
        modelLabel: "Claude Haiku 5.5",
        allowances: { free: 500, pro: 5000, team: 20000 },
        users: [
          { id: "11111111-1111-4111-8111-111111111111", username: "saad", displayName: "Saad Khan", email: "saad@example.com", role: "owner", status: "active", planId: "pro", creditBalance: 3200, creditAllowance: 5000, modelCalls: 12, costUsd: 0.42, suspended: false },
          { id: "22222222-2222-4222-8222-222222222222", username: "ada", displayName: "Ada Lovelace", email: "ada@example.com", role: "member", status: "active", planId: "free", creditBalance: 500, creditAllowance: 500, modelCalls: 2, costUsd: 0, suspended: false },
        ],
      });
    }
    if (path === "/api/admin/console/overview") {
      return json({ activeUsers: 2, mrrCents: 2000, signups: 1, awakeComputers: 1, aiSpendTodayUsd: 1.25, aiSpendMonthUsd: 18.4, errors: 0, health: "up", maxComputers: 3, spendSeries: [0.2, 0.4, 0.3, 0.8, 1.1, 0.9, 1.25], signupSeries: [0, 1, 0, 0, 2, 1, 1], errorSeries: [1, 0, 0, 2, 0, 0, 0] });
    }
    if (path === "/api/admin/console/orgs") return json({ organizations: [{ id: "org-1", name: "Primary", members: 2 }] });
    if (path.startsWith("/api/admin/console/users/")) return json({ notes: [{ id: "n1", body: "Asked about credits.", author: "saad" }], organizations: [], limits: null });
    if (path === "/api/admin/console/bots") return json({ bots: [{ id: "bot-1", name: "Research", status: "idle", username: "ada" }] });
    if (path.includes("/runs")) return json({ runs: [{ id: "run-1", title: "Morning brief", status: "completed" }], transcript: [{ seq: 1, role: "assistant", bytes: 42, redacted: true }], revealed: false });
    if (path === "/api/admin/console/computers") {
      return json({
        host: "local",
        maxComputers: 3,
        savedMaxComputers: null,
        note: "The running process keeps MAX_COMPUTERS until it restarts.",
        computers: [{ computerId: "c1", username: "ada", status: "running", host: "local", quotaCpuMillis: 1000, quotaMemoryBytes: 2147483648, quotaDiskBytes: 10737418240, cpuRatio: null, memoryBytes: null, diskBytes: null, metrics: "quota" }],
        jobs: [{ id: "job-1", title: "Index notes", status: "running", username: "ada" }],
      });
    }
    if (path === "/api/admin/console/plans") {
      return json({
        caps: { storageMb: 51200, ramMb: 8192, cpuMillis: 8000 },
        topup: { enabled: false, packCredits: 1000, packCents: 500, maxPacksPerWeek: 4 },
        plans: [
          { planId: "free", priceCents: 0, weeklyCredits: 125, storageMb: 1024, ramMb: 1024, cpuMillis: 500 },
          { planId: "pro", priceCents: 2000, weeklyCredits: 1250, storageMb: 10240, ramMb: 4096, cpuMillis: 2000 },
        ],
      });
    }
    if (path === "/api/admin/console/billing") {
      return json({
        provider: { name: "mock", status: "mock", chargesCard: false },
        usage: [{ id: "ada", username: "ada", aiCalls: 2, computerTasks: 1, storageBytes: 4096, credits: 500 }],
        invoices: [{ id: "inv-1", number: "AT-1001", username: "saad", amountCents: 2000, status: "paid", provider: "mock" }],
        ledger: [],
      });
    }
    if (path === "/api/admin/console/models") {
      return json({
        killSwitch: false,
        merge: { branch: "speed-v1", safetyFeatures: 12, contract: "model_registry" },
        models: [{ id: "anthropic/claude-haiku-5.5", label: "Claude Haiku 5.5", provider: "anthropic", enabled: true, isDefault: true, isFallback: true, dailySpendCapCents: 0, killed: false }],
      });
    }
    if (path === "/api/admin/console/storage") {
      return json({
        objectStore: { status: "unavailable", bucket: "artifacts", detail: "No endpoint" },
        users: [{ username: "ada", bytes: 4096, files: 1 }],
        cleanups: [],
        backups: [{ id: "b1", status: "recorded", note: "Size recorded. An offsite copy is not configured." }],
      });
    }
    if (path === "/api/admin/console/plugins") return json({ plugins: [{ id: "drive", name: "Drive", category: "files", blocked: false, featured: true, healthStatus: "unknown" }] });
    if (path === "/api/admin/console/flags") {
      return json({
        maintenanceMessage: "",
        flags: [
          { key: "signups_open", enabled: true, description: "Invitation accept can create accounts.", kind: "flag" },
          { key: "model_kill", enabled: false, description: "Stop model calls.", kind: "kill" },
          { key: "maintenance_mode", enabled: false, description: "Show the maintenance banner.", kind: "maintenance" },
        ],
      });
    }
    if (path === "/api/admin/console/announcements") return json({ announcements: [{ id: "a1", title: "Weekly note", body: "Credits reset on Monday.", kind: "banner", published: true }] });
    if (path === "/api/admin/console/templates") return json({ provider: "resend", configured: false, templates: [{ id: "welcome", subject: "Welcome to AI Teammates", body: "Your account is ready." }] });
    if (path === "/api/admin/console/support") {
      return json({
        tickets: [{ id: "t1", email: "ada@example.com", topic: "billing", body: "Where are my credits?", status: "open", staffNote: "" }],
        feedback: [{ id: "f1", username: "ada", message: "The composer is clear." }],
        thumbsDown: [],
      });
    }
    if (path === "/api/admin/console/security") {
      return json({
        sessions: [{ id: "s1", username: "saad", role: "owner", ip: "" }],
        apiKeys: [{ id: "k1", name: "ops", prefix: "ab12cd34", revokedAt: null }],
        allowlist: [],
        secrets: [{ id: "sec-1", name: "platform", username: "saad", maskedSuffix: "9f3a" }],
        totp: [{ username: "saad", role: "owner", enrolled: true }],
      });
    }
    if (path === "/api/admin/console/audit") return json({ events: [{ id: 1, at: "2026-10-24T00:00:00Z", actor: "saad", action: "admin.note", detail: "{}" }] });
    if (path === "/api/admin/console/health") {
      return json({ postgres: true, isolation: false, queues: [{ status: "running", count: 1 }], errors: [], modelErrors: [], alerts: [{ id: "spend_cap", enabled: true, threshold: "Daily model cap", channel: "audit" }], uptime: { banner: { label: "No data yet" } } });
    }
    if (path === "/api/admin/console/settings") return json({ brand_name: "AI Teammates", support_email: "help@example.com", app_domain: "app.example.com", admin_domain: "admin.example.com", legal_terms: "", legal_privacy: "" });
    if (path === "/api/admin/platform" && method === "PUT") return json({ modelId: "anthropic/claude-haiku-5.5", modelLabel: "Claude Haiku 5.5", allowances: { free: 500, pro: 5000, team: 20000 } });
    return json({ ok: true });
  });
}

async function signIn(page: Page, username: string) {
  await page.goto("/login?theme=light");
  await page.getByTestId("admin-username").fill(username);
  await page.getByTestId("admin-password").fill("teammates-dev");
  await page.getByTestId("admin-submit").click();
  await expect(page.getByTestId("admin-app")).toBeVisible({ timeout: 60_000 });
}

async function fit(page: Page) {
  const height = await page.getByTestId("admin-app").evaluate((el) => Math.ceil(el.scrollHeight + 24));
  await page.setViewportSize({ width: 1440, height: Math.max(900, Math.min(height, 4000)) });
}

test.use({ baseURL: process.env.ADMIN_URL ?? "http://127.0.0.1:13011" });

test("console sections render in light and dark", async ({ page }) => {
  test.setTimeout(180_000);
  const state = fresh();
  await install(page, state);
  mkdirSync(dir, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1200 });
  await signIn(page, "saad");
  await expect(page.getByTestId("section-overview")).toContainText("Active users");
  await expect(page.getByTestId("admin-stats")).toBeVisible();
  for (const [href, name] of sections) {
    await page.goto(`${href}?theme=light`);
    await expect(page.getByTestId(name === "overview" ? "section-overview" : name === "users" ? "user-search" : `section-${name}`)).toBeVisible();
    await fit(page);
    await page.screenshot({ path: `${dir}/light-${name}.png`, fullPage: true });
  }
  await page.goto("/users/22222222-2222-4222-8222-222222222222?theme=light");
  await expect(page.getByTestId("admin-user-detail")).toBeVisible();
  await page.getByRole("button", { name: "Impersonate" }).click();
  await expect(page.getByTestId("impersonation-banner")).toContainText("Ada Lovelace");
  await fit(page);
  await page.screenshot({ path: `${dir}/light-impersonation.png`, fullPage: true });
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByTestId("impersonation-banner")).toHaveCount(0);

  await page.emulateMedia({ colorScheme: "dark" });
  for (const [href, name] of sections) {
    await page.goto(`${href}?theme=dark`);
    await expect(page.locator("html")).not.toHaveClass(/light/);
    await expect(page.getByTestId(name === "overview" ? "section-overview" : name === "users" ? "user-search" : `section-${name}`)).toBeVisible();
    await fit(page);
    await page.screenshot({ path: `${dir}/dark-${name}.png`, fullPage: true });
  }
  await page.goto("/users/22222222-2222-4222-8222-222222222222?theme=dark");
  await expect(page.getByTestId("admin-user-detail")).toBeVisible();
  await fit(page);
  await page.screenshot({ path: `${dir}/dark-user.png`, fullPage: true });
});

test("read-only staff cannot suspend or delete", async ({ page }) => {
  const state = fresh();
  await install(page, state);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, "readonly");
  await page.goto("/users?theme=light");
  await expect(page.getByTestId("suspend-ada")).toHaveCount(0);
  await page.goto("/billing?theme=light");
  await expect(page.getByRole("button", { name: "Refund" })).toHaveCount(0);
  await page.goto("/models?theme=light");
  await expect(page.getByTestId("section-models")).toContainText("speed-v1");
});
