import { mkdirSync } from "node:fs";
import { expect, test, type Page, type Route } from "@playwright/test";

const bot = "11111111-1111-4111-8111-111111111111";
const dir = "/opt/cursor/artifacts/connect-apps";

const catalog = [
  { id: "notion", name: "Notion", category: "Productivity", authType: "none", description: "Search Notion pages and databases", trust: "official", toolCount: 2 },
  { id: "onepassword", name: "1Password", category: "Password Managers", authType: "oauth", description: "Share a dedicated 1Password vault", toolCount: 1 },
  { id: "github", name: "GitHub", category: "Code", authType: "oauth", description: "Repositories, pull requests, and issues", toolCount: 4 },
  { id: "stripe", name: "Stripe", category: "Finance", authType: "api_key", description: "Stripe plugin for Cursor to help with payments", toolCount: 3 },
  { id: "slack", name: "Slack", category: "Communication", authType: "oauth", description: "Slack AI tools for users and developers", trust: "official", toolCount: 2 },
  { id: "figma", name: "Figma", category: "Design", authType: "none", description: "Design files and comments", toolCount: 1 },
  { id: "linear", name: "Linear", category: "Productivity", authType: "oauth", description: "Issues, projects, and cycles", toolCount: 2 },
  { id: "datadog", name: "Datadog", category: "Research", authType: "api_key", description: "Inspect and query Datadog logs", toolCount: 2 },
];

function fulfill(route: Route, body: unknown) {
  return route.fulfill({ json: body });
}

async function installApi(page: Page, failCatalog = false) {
  await page.addInitScript(() => {
    const theme = new URLSearchParams(location.search).get("theme");
    if (theme === "light" || theme === "dark" || theme === "system") localStorage.setItem("teammates-theme", theme);
  });
  await page.route("**/api/**", async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    if (url.includes("/api/events")) {
      await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: ": connected\n\n" });
      return;
    }
    if (url.includes("/api/auth/me")) {
      await fulfill(route, { username: "saad", displayName: "Muhammad Saad Khan", role: "owner" });
      return;
    }
    if (url.includes("/api/plugins/install") && method === "POST") {
      await fulfill(route, { id: "install-notion", catalogId: "notion", status: "installed" });
      return;
    }
    if (url.includes("/api/plugins/catalog")) {
      if (failCatalog) {
        await route.fulfill({ status: 500, json: { error: "catalog down" } });
        return;
      }
      const parsed = new URL(url);
      const q = (parsed.searchParams.get("q") ?? "").toLowerCase();
      const category = parsed.searchParams.get("category") ?? "";
      const items = catalog.filter((item) => {
        if (category && item.category.toLowerCase() !== category.toLowerCase()) return false;
        if (!q) return true;
        return `${item.name} ${item.description} ${item.category}`.toLowerCase().includes(q);
      });
      await fulfill(route, { items, total: items.length, categories: ["Productivity", "Password Managers", "Code", "Finance", "Communication", "Design", "Research"], stats: { imported: catalog.length } });
      return;
    }
    if (url.includes("/api/plugins")) {
      await fulfill(route, [
        { id: "gmail", name: "Gmail", authType: "oauth", secretId: "sec-1", status: "installed", catalogId: "gmail", manifest: { tools: [{ name: "send" }], summary: "Mail" } },
        { id: "drive", name: "Google Drive", authType: "none", status: "installed", catalogId: "drive", manifest: { tools: [{ name: "list" }] } },
      ]);
      return;
    }
    if (url.includes("/skills")) {
      await fulfill(route, [{ id: "skill-1", name: "Daily Scholarship Discovery", description: "Scan official university and scholarship websites" }]);
      return;
    }
    if (url.includes("/workspace")) {
      await fulfill(route, {
        bot: { id: bot, name: "Ada", role: "Teammate", status: "idle", avatarColor: "#ff3045" },
        conversationId: bot,
        tasks: [],
        messages: [],
        approvals: [],
        pages: [],
        holder: "agent",
        openrouterConnected: true,
        codingJobs: [],
      });
      return;
    }
    if (url.includes("/api/bots") && method === "GET") {
      await fulfill(route, [{ id: bot, name: "Ada", role: "Research", section: "Teammates" }]);
      return;
    }
    await fulfill(route, []);
  });
}

test("connect apps opens from the footer, filters, and manages plugins", async ({ page }) => {
  mkdirSync(dir, { recursive: true });
  await installApi(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/bots/${bot}?theme=dark`);
  await page.getByTestId("open-plugins").click();
  const modal = page.getByTestId("plugins-modal");
  await expect(modal).toBeVisible();
  await expect(modal.getByRole("heading", { name: "Connect Apps" })).toBeVisible();
  const radius = await modal.evaluate((node) => Number.parseFloat(getComputedStyle(node).borderRadius));
  expect(radius).toBe(16);
  const box = await modal.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(480);
  expect(box?.width ?? 0).toBeLessThan(560);
  await expect(page.getByTestId("connect-app").filter({ hasText: "Notion" }).first()).toBeVisible();
  await expect(page.getByTestId("connect-app").filter({ hasText: "Notion" }).first().getByTestId("app-logo")).toHaveAttribute("data-logo", "brand");
  await expect(page.getByTestId("connect-manage").getByTestId("app-logo").first()).toHaveAttribute("data-logo", "brand");
  await expect(page.getByTestId("connect-manage")).toContainText("2 connected");
  const categories = page.getByTestId("connect-categories");
  const categoryHeight = await categories.evaluate((node) => node.getBoundingClientRect().height);
  expect(categoryHeight).toBeLessThan(36);
  const categoryBox = await categories.boundingBox();
  const chipCount = await categories.getByTestId("connect-category").count();
  for (let index = 0; index < chipCount; index += 1) {
    const chipBox = await categories.getByTestId("connect-category").nth(index).boundingBox();
    expect((chipBox?.x ?? 0) + (chipBox?.width ?? 0)).toBeLessThanOrEqual((categoryBox?.x ?? 0) + (categoryBox?.width ?? 0) + 1);
  }
  const productivity = page.locator("section").filter({ has: page.getByRole("heading", { name: "Productivity" }) });
  const grid = productivity.locator(".grid").first();
  const cell = grid.getByTestId("connect-app").first();
  const cellBox = await cell.boundingBox();
  const gridBox = await grid.boundingBox();
  expect(cellBox?.width ?? 0).toBeGreaterThan((gridBox?.width ?? 0) * 0.45);
  expect(cellBox?.width ?? 0).toBeLessThan((gridBox?.width ?? 0) * 0.55);
  const action = await cell.getByTestId("connect-action").boundingBox();
  expect((cellBox?.x ?? 0) + (cellBox?.width ?? 0) - ((action?.x ?? 0) + (action?.width ?? 0))).toBeLessThan(16);
  const password = page.locator("section").filter({ has: page.getByRole("heading", { name: "Password Managers" }) });
  await expect(password.getByTestId("connect-app")).toHaveCount(1);
  const lone = await password.getByTestId("connect-app").boundingBox();
  const loneGrid = await password.locator("div.grid").first().boundingBox();
  expect(lone?.width ?? 0).toBeLessThan((loneGrid?.width ?? 0) * 0.6);
  await modal.screenshot({ path: `${dir}/dark-top.png` });

  await page.getByLabel("Search across apps and skills").fill("notion");
  await expect(page.getByTestId("connect-app").filter({ hasText: "Notion" }).first()).toBeVisible();
  await expect(page.getByTestId("connect-app").filter({ hasText: "GitHub" })).toHaveCount(0);

  await page.getByLabel("Search across apps and skills").fill("");
  const codeChip = page.getByTestId("connect-categories").getByTestId("connect-category").filter({ hasText: /^Code$/ });
  if (await codeChip.count()) await codeChip.click();
  else {
    await page.getByTestId("connect-more").click();
    await page.getByTestId("connect-more-item").filter({ hasText: /^Code$/ }).click();
  }
  await expect(page.getByTestId("connect-app").filter({ hasText: "GitHub" }).first()).toBeVisible();
  await expect(page.getByTestId("connect-app").filter({ hasText: "Notion" })).toHaveCount(0);

  await page.getByTestId("connect-category").filter({ hasText: "All" }).click();
  await page.getByLabel("Search across apps and skills").fill("zzz-no-app");
  await expect(page.getByTestId("connect-apps-empty")).toBeVisible();
  await page.getByLabel("Search across apps and skills").fill("");
  await expect(page.getByTestId("connect-app").filter({ hasText: "Notion" }).first()).toBeVisible();

  const scroll = page.getByTestId("connect-apps-scroll");
  await scroll.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  const searchBox = await page.getByLabel("Search across apps and skills").boundingBox();
  const modalBox = await modal.boundingBox();
  expect((searchBox?.y ?? 0) - (modalBox?.y ?? 0)).toBeLessThan(20);
  await modal.screenshot({ path: `${dir}/dark-scrolled.png` });

  await page.getByTestId("connect-manage").click();
  await expect(modal.getByRole("heading", { name: "Manage plugins and skills" })).toBeVisible();
  await expect(page.getByTestId("connect-installed").filter({ hasText: "Gmail" })).toContainText("Connected");
  await expect(page.getByTestId("connect-installed").filter({ hasText: "Gmail" })).toContainText("1 connector, 1 skill");
  await expect(page.getByTestId("connect-skill")).toContainText("Daily Scholarship Discovery");
  await expect(page.getByTestId("connect-skill")).toContainText("Created locally");
  await modal.screenshot({ path: `${dir}/dark-manage.png` });
  await page.getByTestId("connect-back").click();
  await expect(modal.getByRole("heading", { name: "Connect Apps" })).toBeVisible();

  await page.getByTestId("connect-action").filter({ hasText: "Add" }).first().click();
  await expect(page.getByText("Installed.")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();

  await page.goto(`/bots/${bot}?theme=light`);
  await page.getByTestId("open-plugins").click();
  await expect(page.getByRole("heading", { name: "Connect Apps" })).toBeVisible();
  await modal.screenshot({ path: `${dir}/light-top.png` });
  await page.getByTestId("connect-manage").click();
  await modal.screenshot({ path: `${dir}/light-manage.png` });
});

test("connect apps shows an error when the catalog fails", async ({ page }) => {
  await installApi(page, true);
  await page.goto(`/bots/${bot}?theme=dark`);
  await page.getByTestId("open-plugins").click();
  await expect(page.getByTestId("connect-apps-error")).toBeVisible();
  await expect(page.getByTestId("connect-apps-error")).toContainText("Could not load apps");
});
