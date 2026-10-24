import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const dir = process.env.SHOT_DIR ?? "test-results/admin-app";
test.skip(!process.env.ADMIN_URL, "ADMIN_URL is required for the imported admin shell.");

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
    role: "owner" as string,
    signedIn: false,
    modelId: "anthropic/claude-haiku-5.5",
    modelLabel: "Claude Haiku 5.5",
    allowances: { free: 500, pro: 5000, team: 20000 } as Record<string, number>,
    users: [
      { id: "11111111-1111-4111-8111-111111111111", username: "saad", displayName: "Saad Khan", email: "saad@example.com", role: "owner", status: "active", planId: "pro", creditBalance: 3200, creditAllowance: 5000, modelCalls: 12, costUsd: 0, suspended: false },
      { id: "22222222-2222-4222-8222-222222222222", username: "ada", displayName: "Ada Lovelace", email: "ada@example.com", role: "member", status: "active", planId: "free", creditBalance: 500, creditAllowance: 500, modelCalls: 2, costUsd: 0, suspended: false },
    ] as User[],
  };
}

function staff(role: string) {
  return role === "owner" || role === "admin";
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
      const body = request.postDataJSON() as { username?: string; password?: string };
      if (body.password !== "teammates-dev") return json({ error: "unauthorized" }, 401);
      state.role = body.username === "member" ? "member" : body.username === "ada" ? "admin" : "owner";
      state.signedIn = true;
      return json({ username: body.username });
    }
    if (path === "/api/auth/logout" && method === "POST") {
      state.signedIn = false;
      return json({ ok: true });
    }
    if (path === "/api/auth/me") {
      if (!state.signedIn) return json({ error: "unauthorized" }, 401);
      return json({ username: state.role === "member" ? "member" : "saad", role: state.role, theme: "system" });
    }
    if (path === "/api/settings/appearance" && method === "PUT") return json({ theme: "system" });
    if (!state.signedIn) return json({ error: "unauthorized" }, 401);
    if (!staff(state.role)) return json({ error: "forbidden" }, 403);
    if (path === "/api/admin/accounts") {
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
    return json({});
  });
}

async function signIn(page: Page, username: string) {
  await page.goto("/login?theme=light");
  await expect(page.getByTestId("admin-login")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("admin-username").fill(username);
  await page.getByTestId("admin-password").fill("teammates-dev");
  await page.getByTestId("admin-submit").click();
}

test.use({ baseURL: process.env.ADMIN_URL ?? "http://127.0.0.1:13011" });

test("admin app renders in light and dark and edits users", async ({ page }) => {
  const state = fresh();
  await install(page, state);
  mkdirSync(dir, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1400 });
  await page.emulateMedia({ colorScheme: "light" });
  await signIn(page, "saad");
  await expect(page.getByTestId("admin-app")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("admin-skeleton")).toHaveCount(0);
  await expect(page.locator("html")).toHaveClass(/light/);
  await expect(page.getByTestId("admin-stats")).toBeVisible();
  await expect(page.getByTestId("admin-chart")).toBeVisible();
  const fit = async () => {
    const height = await page.getByTestId("admin-app").evaluate((el) => Math.ceil(el.scrollHeight + 24));
    await page.setViewportSize({ width: 1440, height: Math.max(900, height) });
  };
  await fit();
  await page.screenshot({ path: `${dir}/light-dashboard.png`, fullPage: true });
  await page.screenshot({ path: `${dir}/light.png`, fullPage: true });

  await page.getByRole("link", { name: "Users" }).click();
  await expect(page.getByTestId("user-search")).toBeVisible();
  await page.getByTestId("user-search").fill("zzzz");
  await expect(page.getByTestId("admin-empty")).toContainText("No users match that search.");
  await page.getByTestId("user-search").fill("ada");
  await expect(page.getByTestId("user-ada")).toContainText("2 calls");
  await page.getByTestId("suspend-ada").click();
  await expect(page.getByTestId("user-ada")).toContainText("Suspended");
  await page.getByTestId("suspend-ada").click();
  await expect(page.getByTestId("suspend-ada")).toHaveText("Suspend");
  await page.getByTestId("user-search").fill("");
  await fit();
  await page.screenshot({ path: `${dir}/light-users.png`, fullPage: true });
  await page.getByRole("link", { name: "Ada Lovelace" }).click();
  await expect(page.getByTestId("admin-user-detail")).toBeVisible();
  await fit();
  await page.screenshot({ path: `${dir}/light-user.png`, fullPage: true });

  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByTestId("platform-form")).toContainText("AI models");
  await expect(page.getByTestId("platform-form")).toContainText("no account billing");
  await fit();
  await page.screenshot({ path: `${dir}/light-settings.png`, fullPage: true });

  await page.emulateMedia({ colorScheme: "dark" });
  await page.getByTestId("admin-theme-dark").click();
  await expect(page.locator("html")).not.toHaveClass(/light/);
  await page.goto("/?theme=dark");
  await expect(page.getByTestId("admin-chart")).toBeVisible();
  await fit();
  await page.screenshot({ path: `${dir}/dark-dashboard.png`, fullPage: true });
  await page.screenshot({ path: `${dir}/dark.png`, fullPage: true });
  await page.goto("/users?theme=dark");
  await expect(page.getByTestId("user-ada")).toBeVisible();
  await fit();
  await page.screenshot({ path: `${dir}/dark-users.png`, fullPage: true });
  await page.goto("/users/22222222-2222-4222-8222-222222222222?theme=dark");
  await expect(page.getByTestId("admin-user-detail")).toBeVisible();
  await fit();
  await page.screenshot({ path: `${dir}/dark-user.png`, fullPage: true });
  await page.goto("/settings?theme=dark");
  await expect(page.getByTestId("platform-form")).toBeVisible();
  await fit();
  await page.screenshot({ path: `${dir}/dark-settings.png`, fullPage: true });
  await page.goto("/login?theme=dark");
  await expect(page.getByTestId("admin-login")).toBeVisible();
  await page.screenshot({ path: `${dir}/dark-login.png`, fullPage: true });
  await page.goto("/login?theme=light");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.getByTestId("admin-login")).toBeVisible();
  await page.screenshot({ path: `${dir}/light-login.png`, fullPage: true });
});

test("members cannot stay signed in", async ({ page }) => {
  const state = fresh();
  await install(page, state);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, "member");
  await expect(page.getByText("This sign-in is for owners and admins.")).toBeVisible();
  await expect(page.getByTestId("user-search")).toHaveCount(0);
  await expect(page).toHaveURL(/\/login/);
});

test("an admin role can open the panel", async ({ page }) => {
  const state = fresh();
  await install(page, state);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, "ada");
  await expect(page.getByTestId("admin-app")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("admin-nav")).toBeVisible();
});
