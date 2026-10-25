import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const dir = "/opt/cursor/artifacts/account-pages";

test.use({ baseURL: process.env.WEB_URL ?? "http://127.0.0.1:13010" });
const plans = [
  { id: "free", name: "Free", detail: "Try a teammate with a small monthly credit grant.", priceCents: 0, monthlyCredits: 500 },
  { id: "pro", name: "Pro", detail: "Daily work with your teammates.", priceCents: 2000, monthlyCredits: 5000 },
  { id: "team", name: "Team", detail: "A shared pool of monthly credits.", priceCents: 8000, monthlyCredits: 20000 },
];

type User = {
  id: string;
  username: string;
  displayName: string;
  email: string;
  role: string;
  status: string;
  planId: string;
  creditBalance: number;
  creditAllowance: number;
  modelCalls: number;
  costUsd: number;
  suspended: boolean;
};

function fresh() {
  return {
    theme: "dark",
    role: "owner",
    displayName: "Saad Khan",
    email: "saad@example.com",
    avatarUrl: "",
    productUpdates: false,
    canDelete: false,
    google: false,
    github: false,
    planId: "pro",
    creditBalance: 3200,
    creditAllowance: 5000,
    modelId: "anthropic/claude-haiku-5.5",
    modelLabel: "Claude Haiku 5.5",
    allowances: { free: 500, pro: 5000, team: 20000 } as Record<string, number>,
    invoices: [
      { id: "inv-1", number: "INV-20261001-ABC123", planId: "pro", amountCents: 2000, currency: "usd", status: "paid", provider: "mock", issuedAt: "2026-10-01T12:00:00.000Z" },
    ],
    users: [
      { id: "11111111-1111-4111-8111-111111111111", username: "saad", displayName: "Saad Khan", email: "saad@example.com", role: "owner", status: "active", planId: "pro", creditBalance: 3200, creditAllowance: 5000, modelCalls: 12, costUsd: 0, suspended: false },
      { id: "22222222-2222-4222-8222-222222222222", username: "ada", displayName: "Ada Lovelace", email: "ada@example.com", role: "member", status: "active", planId: "free", creditBalance: 500, creditAllowance: 500, modelCalls: 2, costUsd: 0, suspended: false },
    ] as User[],
    fail: "" as string,
    delay: "",
    emptyInvoices: false,
    emptyFaq: false,
    emptyLog: false,
  };
}

function profile(state: ReturnType<typeof fresh>) {
  return {
    id: state.users[0].id,
    username: "saad",
    role: state.role,
    status: "active",
    displayName: state.displayName,
    email: state.email,
    avatarUrl: state.avatarUrl,
    productUpdates: state.productUpdates,
    canDelete: state.canDelete,
    identities: [
      { provider: "password", label: "Password", connected: true, detail: "This sign-in uses your password." },
      { provider: "google", label: "Google", connected: state.google, detail: state.google ? "Connected." : "Not connected." },
      { provider: "github", label: "GitHub", connected: state.github, detail: state.github ? "Connected." : "Not connected." },
    ],
  };
}

function billing(state: ReturnType<typeof fresh>) {
  const used = Math.max(0, state.creditAllowance - Math.max(0, state.creditBalance));
  const usedPercent = state.creditAllowance <= 0 ? 0 : Math.min(100, Math.round((used * 100) / state.creditAllowance));
  return {
    planId: state.planId,
    creditBalance: state.creditBalance,
    creditAllowance: state.creditAllowance,
    usedCredits: used,
    usedPercent,
    provider: "mock",
    chargesCard: false,
    mockMode: true,
    modelId: state.modelId,
    modelLabel: state.modelLabel,
    modelCalls: 12,
    costUsd: 0,
    renewsAt: "2026-11-01T00:00:00.000Z",
    plans,
    invoices: state.emptyInvoices ? [] : state.invoices,
  };
}

async function install(page: Page, state: ReturnType<typeof fresh>) {
  await page.addInitScript(() => {
    const theme = new URLSearchParams(location.search).get("theme");
    if (theme === "light" || theme === "dark" || theme === "system") localStorage.setItem("teammates-theme", theme);
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (state.delay && path === state.delay) await new Promise((resolve) => setTimeout(resolve, 700));
    if (state.fail && path === state.fail) {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "The service failed." }) });
      return;
    }
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/events") {
      await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: ": connected\n\n" });
      return;
    }
    if (path === "/api/auth/me") return json({ username: "saad", displayName: state.displayName, avatarUrl: state.avatarUrl, role: state.role, email: state.email, theme: state.theme });
    if (path === "/api/settings/appearance" && method === "PUT") {
      state.theme = (request.postDataJSON() as { theme?: string }).theme ?? state.theme;
      return json({ theme: state.theme });
    }
    if (path === "/api/account" && method === "GET") return json(profile(state));
    if (path === "/api/account" && method === "PATCH") {
      const body = request.postDataJSON() as { displayName?: string; email?: string; avatarUrl?: string; productUpdates?: boolean };
      if (body.displayName) state.displayName = body.displayName;
      if (typeof body.email === "string") state.email = body.email;
      if (typeof body.avatarUrl === "string") state.avatarUrl = body.avatarUrl;
      if (typeof body.productUpdates === "boolean") state.productUpdates = body.productUpdates;
      return json(profile(state));
    }
    if (path === "/api/account/password" && method === "POST") {
      const body = request.postDataJSON() as { newPassword?: string };
      if (!body.newPassword || body.newPassword.length < 12 || body.newPassword.length > 256 || !/[A-Za-z]/.test(body.newPassword) || !/[0-9]/.test(body.newPassword)) return json({ error: "Use at least 12 characters with letters and numbers, up to 256 characters." }, 400);
      return json({ ok: true });
    }
    if (path === "/api/account/identities" && method === "POST") {
      const body = request.postDataJSON() as { provider?: string };
      if (body.provider === "google") state.google = true;
      if (body.provider === "github") state.github = true;
      return json(profile(state));
    }
    if (path.startsWith("/api/account/identities/") && method === "DELETE") {
      const provider = path.split("/").pop();
      if (provider === "google") state.google = false;
      if (provider === "github") state.github = false;
      return json(profile(state));
    }
    if (path === "/api/account" && method === "DELETE") {
      if (!state.canDelete) return json({ error: "The only owner cannot delete this account." }, 409);
      return json({ ok: true });
    }
    if (path === "/api/billing/checkout" && method === "POST") {
      const body = request.postDataJSON() as { planId: string };
      const plan = plans.find((item) => item.id === body.planId);
      if (!plan) return json({ error: "Unknown plan." }, 400);
      state.planId = plan.id;
      state.creditAllowance = state.allowances[plan.id] ?? plan.monthlyCredits;
      state.creditBalance = state.creditAllowance;
      let invoiceNumber: string | null = null;
      if (plan.priceCents > 0) {
        invoiceNumber = `INV-20261024-${plan.id.toUpperCase()}`;
        state.invoices = [{ id: invoiceNumber, number: invoiceNumber, planId: plan.id, amountCents: plan.priceCents, currency: "usd", status: "paid", provider: "mock", issuedAt: "2026-10-24T12:00:00.000Z" }, ...state.invoices];
      }
      state.users[0].planId = state.planId;
      state.users[0].creditBalance = state.creditBalance;
      state.users[0].creditAllowance = state.creditAllowance;
      return json({ provider: "mock", status: "completed", planId: plan.id, chargesCard: false, checkoutUrl: null, invoiceNumber });
    }
    if (path === "/api/billing") return json(billing(state));
    if (path === "/api/help") {
      return json({
        faq: state.emptyFaq ? [] : [
          { id: "credits", question: "Where do monthly credits come from?", answer: "Each plan includes a monthly credit grant. The platform spends those credits when a teammate works." },
          { id: "answers", question: "Who chooses how a teammate answers?", answer: "The platform chooses. You do not pick or paste an id." },
          { id: "payments", question: "How do payments work?", answer: "Open Billing, compare the plans, and choose one. Paid plans renew monthly." },
          { id: "password", question: "How do I change my password?", answer: "Open Account and choose Update password." },
          { id: "delete", question: "How do I delete my account?", answer: "The danger card at the bottom of Account asks for your password and the word DELETE." },
          { id: "admin", question: "Where are users and credits managed?", answer: "Owners and admins use a separate admin site. It is not a page in this app." },
        ],
        docs: [
          { href: "/docs/COMPANION.md", title: "Companion app", detail: "Install the desktop companion." },
          { href: "/settings/usage", title: "Usage", detail: "Credits left for this account." },
          { href: "/account/status", title: "Status", detail: "Whether the platform is up." },
          { href: "/account/changelog", title: "Changelog", detail: "What shipped recently." },
        ],
        topics: ["account", "billing", "bug", "other"],
      });
    }
    if (path === "/api/support" && method === "POST") return json({ id: "msg-1" }, 201);
    if (path === "/api/legal/terms" || path === "/api/legal/privacy") {
      const privacy = path.endsWith("privacy");
      return json({
        placeholder: true,
        title: privacy ? "Privacy" : "Terms of use",
        banner: "PLACEHOLDER. This text is not a legal agreement and it is not legal advice.",
        body: privacy
          ? "PLACEHOLDER. This privacy note is sample copy. It stores a name, email, avatar, and credit balance. PLACEHOLDER."
          : "PLACEHOLDER. These terms are sample copy. Plans grant monthly credits and renew on the first of each month. PLACEHOLDER.",
      });
    }
    if (path === "/api/status") return json(statusBoard());
    if (path === "/api/changelog") {
      return json({
        entries: state.emptyLog ? [] : [
          { id: "account-pages", date: "2026-10-24", title: "Account, billing, and support", body: "Profile, billing, help, legal pages, status, and changelog. Owners and admins use a separate admin site." },
          { id: "themes", date: "2026-10-23", title: "Light, dark, and system", body: "Every surface follows the theme." },
          { id: "credits", date: "2026-10-23", title: "Platform credits", body: "Plans grant monthly credits. Usage on this site shows credits only." },
        ],
      });
    }
    if (path === "/api/admin/accounts") {
      if (state.role !== "owner") return json({ error: "forbidden" }, 403);
      return json({ runtimeProvider: "mock", modelId: state.modelId, modelLabel: state.modelLabel, allowances: state.allowances, users: state.users });
    }
    if (path === "/api/admin/platform" && method === "PUT") {
      const body = request.postDataJSON() as { modelId: string; modelLabel: string; allowances: Record<string, number> };
      state.modelId = body.modelId;
      state.modelLabel = body.modelLabel;
      state.allowances = body.allowances;
      return json({ modelId: state.modelId, modelLabel: state.modelLabel, allowances: state.allowances, runtimeProvider: "mock" });
    }
    if (/^\/api\/admin\/users\/[^/]+\/billing$/.test(path) && method === "PATCH") {
      const id = path.split("/")[4];
      const body = request.postDataJSON() as { planId?: string; creditBalance?: number };
      const user = state.users.find((item) => item.id === id);
      if (!user) return json({ error: "missing" }, 404);
      if (body.planId) user.planId = body.planId;
      if (typeof body.creditBalance === "number") user.creditBalance = body.creditBalance;
      return json({ id, planId: user.planId, creditBalance: user.creditBalance, creditAllowance: user.creditAllowance });
    }
    if (/^\/api\/admin\/users\/[^/]+$/.test(path) && method === "PATCH") {
      const id = path.split("/")[4];
      const body = request.postDataJSON() as { status?: string };
      const user = state.users.find((item) => item.id === id);
      if (!user) return json({ error: "missing" }, 404);
      user.status = body.status ?? user.status;
      user.suspended = user.status === "disabled";
      return json(user);
    }
    if (path === "/api/bots" || path === "/api/notifications" || path === "/api/plugins") return json([]);
    return json([]);
  });
}

function statusBoard() {
  const days = Array.from({ length: 90 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 9, 24));
    date.setUTCDate(date.getUTCDate() - (89 - index));
    const state = index === 40 ? "down" : "up";
    return { date: date.toISOString().slice(0, 10), state, uptimePercent: state === "down" ? 0 : 100, incidents: state === "down" ? 1 : 0 };
  });
  const services = [
    ["api", "API", "The application API for sign-in, billing, and settings."],
    ["chat", "Chat/Realtime", "Live delivery of messages between you and your teammates."],
    ["computers", "Bot computers", "Computers teammates use for files and browsing."],
    ["agents", "Coding agents", "Workers that run coding jobs and routines."],
    ["integrations", "Integrations/Connectors", "Connected apps and remote plugins."],
    ["notifications", "Notifications", "System for sending notices to users."],
    ["storage", "Storage", "Database and workspace files."],
  ].map(([id, name, description]) => ({ id, name, description, status: "up", days }));
  return {
    indicator: "none",
    description: "All systems operational",
    services,
    incidents: [{ id: "inc-1", service: "API", title: "API is down", status: "resolved", startedAt: "2026-09-05T12:00:00.000Z", resolvedAt: "2026-09-05T13:00:00.000Z" }],
  };
}

const pages = [
  ["account", "/account", "account-page"],
  ["billing", "/account/billing", "billing-page"],
  ["help", "/account/help", "help-page"],
  ["terms", "/account/legal/terms", "terms-page"],
  ["privacy", "/account/legal/privacy", "privacy-page"],
  ["status", "/account/status", "status-page"],
  ["changelog", "/account/changelog", "changelog-page"],
] as const;

test("account pages render in light and dark", async ({ page }) => {
  const state = fresh();
  await install(page, state);
  mkdirSync(dir, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    state.theme = theme;
    await page.emulateMedia({ colorScheme: theme });
    for (const [name, href, testId] of pages) {
      await page.setViewportSize({ width: 1440, height: 2400 });
      await page.goto(`${href}?theme=${theme}`);
      await expect(page.getByTestId(testId)).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId("page-skeleton")).toHaveCount(0);
      if (theme === "light") await expect(page.locator("html")).toHaveClass(/light/);
      else await expect(page.locator("html")).not.toHaveClass(/light/);
      await expect(page.getByTestId("account-nav").getByRole("link", { name: "Admin" })).toHaveCount(0);
      await expect(page.locator("body")).not.toContainText(/haiku|claude|anthropic|openrouter|\bgpt\b/i);
      const height = await page.getByTestId(testId).evaluate((el) => Math.ceil((el.parentElement?.getBoundingClientRect().height ?? 900) + 24));
      await page.setViewportSize({ width: 1440, height: Math.max(780, Math.min(height, 2400)) });
      await page.screenshot({ path: `${dir}/${theme}-${name}.png` });
    }
  }
});

test("profile, billing, and help actions", async ({ page }) => {
  const state = fresh();
  state.theme = "light";
  await install(page, state);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/account?theme=light");
  await expect(page.getByTestId("account-page")).toBeVisible({ timeout: 60_000 });
  const card = page.getByTestId("profile-form");
  await expect(card).toHaveCSS("border-radius", "12px");
  await expect(page.getByTestId("profile-name")).toHaveCSS("border-radius", "8px");
  await expect(page.getByTestId("profile-save")).toHaveCSS("border-radius", "9999px");
  await expect(page.getByTestId("identity-google")).toHaveCSS("border-radius", "8px");
  await expect(page.getByTestId("product-updates")).toHaveCSS("border-radius", "9999px");
  await page.getByTestId("profile-name").fill("Saad K");
  await page.getByTestId("profile-save").click();
  await expect(page.getByTestId("profile-name")).toHaveValue("Saad K");
  await page.getByTestId("current-password").fill("teammates-dev");
  await page.getByTestId("new-password").fill("short");
  await page.getByTestId("password-save").click();
  await expect(page.getByTestId("password-form").getByText("Use at least 12 characters with letters and numbers, up to 256 characters.")).toBeVisible();
  await page.getByTestId("new-password").fill("a-longer-password-2");
  await page.getByTestId("password-save").click();
  await expect(page.getByText("Password updated.")).toBeVisible();
  await page.getByRole("button", { name: "Connect", exact: true }).first().click();
  await expect(page.getByTestId("identity-google")).toContainText("Connected.");
  await expect(page.getByTestId("danger-card")).toContainText("The only owner cannot delete this account.");
  await expect(page.getByTestId("delete-account")).toBeDisabled();

  await page.goto("/account/billing?theme=light");
  await expect(page.getByTestId("account-nav").getByRole("link", { name: "Billing" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByTestId("account-nav").getByRole("link", { name: "Account" })).toHaveCount(0);
  await expect(page.getByTestId("credit-balance")).toContainText("3,200");
  await expect(page.getByTestId("usage-meter")).toContainText("36%");
  await expect(page.getByText("Most popular")).toBeVisible();
  await expect(page.getByTestId("billing-page")).not.toContainText(/haiku|claude|anthropic|openrouter|\bgpt\b/i);
  await expect(page.getByRole("columnheader", { name: "Amount" })).toBeVisible();
  await expect(page.getByTestId("invoice-list")).toContainText("INV-20261001-ABC123");
  await expect(page.getByTestId("billing-page")).not.toContainText("mock");
  await expect(page.getByTestId("billing-page")).not.toContainText("anthropic/");
  await page.getByTestId("upgrade-button").click();
  await expect(page.getByTestId("plan-summary")).toContainText("Team");
  await expect(page.getByText("You're on the Team plan.")).toBeVisible();

  state.emptyInvoices = true;
  state.invoices = [];
  await page.goto("/account/billing?theme=light");
  await expect(page.getByText("No invoices yet")).toBeVisible();

  await page.goto("/account/help?theme=light");
  await expect(page.getByTestId("faq-list")).toContainText("monthly credit grant");
  await expect(page.getByTestId("faq-list")).not.toContainText(/haiku|claude|anthropic|openrouter|\bgpt\b/i);
  await expect(page.getByRole("link", { name: /Companion app/ })).toHaveAttribute("href", "/docs/COMPANION.md");
  await page.getByTestId("contact-email").fill("saad@example.com");
  await page.getByTestId("contact-message").fill("The credit meter looks right.");
  await page.getByTestId("contact-send").click();
  await expect(page.getByTestId("contact-sent")).toContainText("Message sent");

  await page.goto("/account/legal/terms?theme=light");
  await expect(page.getByTestId("legal-placeholder")).toContainText("PLACEHOLDER");
  await page.goto("/account/legal/privacy?theme=light");
  await expect(page.getByTestId("privacy-page")).toContainText("PLACEHOLDER");
});

test("loading, error, empty, and member states", async ({ page }) => {
  const state = fresh();
  state.theme = "dark";
  state.delay = "/api/billing";
  await install(page, state);
  await page.goto("/account/billing?theme=dark");
  await expect(page.getByTestId("page-skeleton")).toBeVisible();
  await expect(page.getByTestId("usage-meter")).toBeVisible({ timeout: 60_000 });

  state.delay = "";
  state.fail = "/api/help";
  await page.goto("/account/help?theme=dark");
  await expect(page.getByTestId("page-error")).toBeVisible();
  state.fail = "";
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("faq-list")).toBeVisible();

  state.emptyFaq = true;
  await page.goto("/account/help?theme=dark");
  await expect(page.getByText("No questions yet")).toBeVisible();
  state.emptyFaq = false;
  state.emptyLog = true;
  await page.goto("/account/changelog?theme=dark");
  await expect(page.getByText("No entries yet")).toBeVisible();

  state.role = "member";
  state.canDelete = true;
  await page.goto("/account?theme=dark");
  await expect(page.getByTestId("account-nav").getByRole("link", { name: "Admin" })).toHaveCount(0);
  await page.getByTestId("account-button").click();
  await expect(page.getByRole("menuitem", { name: "Admin" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("delete-account")).toBeEnabled();
  await page.goto("/account/admin?theme=dark");
  await expect(page.getByText("That page is not here")).toBeVisible();
  await expect(page.getByTestId("admin-page")).toHaveCount(0);
});
