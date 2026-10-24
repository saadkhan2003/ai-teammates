import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const bot = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const dir = "/opt/cursor/artifacts/sidebar";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function shot(page: Page, name: string) {
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${name}.png` });
}

async function installApi(page: Page, saved: { theme: string }) {
  await page.addInitScript(() => {
    const theme = new URLSearchParams(location.search).get("theme");
    if (theme === "light" || theme === "dark" || theme === "system") localStorage.setItem("teammates-theme", theme);
  });
  await page.route("**/owner-avatar.png", (route) => route.fulfill({ status: 200, contentType: "image/png", body: png }));
  await page.route("**/api/**", async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    if (url.includes("/api/events")) {
      await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: ": connected\n\n" });
      return;
    }
    if (url.includes("/api/settings/appearance") && method === "PUT") {
      const body = route.request().postDataJSON() as { theme?: string };
      saved.theme = body.theme ?? saved.theme;
      await route.fulfill({ json: { theme: saved.theme } });
      return;
    }
    if (url.includes("/api/auth/me")) {
      await route.fulfill({
        json: {
          username: "saad",
          displayName: "Muhammad Saad Khan",
          avatarUrl: "/owner-avatar.png",
          role: "owner",
          theme: saved.theme,
        },
      });
      return;
    }
    if (url.includes("/artifacts") || url.includes("/routines") || url.includes("/files") || url.includes("/memories") || url.includes("/skills")) {
      await route.fulfill({ json: [] });
      return;
    }
    if (url.includes("/api/plugins")) {
      await route.fulfill({ json: [{ id: "p-notion", name: "Notion" }, { id: "p-spiral", name: "Spiral" }] });
      return;
    }
    if (url.includes("/workspace")) {
      await route.fulfill({
        json: {
          bot: { id: bot, name: "Ada", role: "Teammate", status: "running", avatarColor: "#3366ff" },
          conversationId: bot,
          tasks: [],
          messages: [{ id: "m-user", role: "user", content: "Hello from the composer." }],
          approvals: [],
          pages: [],
          holder: "agent",
          openrouterConnected: true,
          codingJobs: [],
        },
      });
      return;
    }
    if (url.includes("/api/bots")) {
      await route.fulfill({
        json: [
          { id: bot, name: "Ada", role: "Teammate", status: "running", section: "Teammates" },
          { id: other, name: "Nova", role: "Research", status: "idle", section: "Teammates" },
        ],
      });
      return;
    }
    await route.fulfill({ json: [] });
  });
}

test("sidebar, composer, and floating header follow light and dark", async ({ page }) => {
  const saved = { theme: "light" };
  await installApi(page, saved);
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.goto(`/bots/${bot}?theme=light`);
  await expect(page.locator("html")).toHaveClass(/light/);
  const account = page.getByTestId("account-button");
  await expect(account).toContainText("Muhammad Saad Khan");
  await expect(account.locator("img")).toBeVisible();
  const footer = page.getByTestId("sidebar-footer");
  await expect(footer.getByTestId("open-plugins")).toBeVisible();
  await expect(page.getByTestId("assign-task")).toHaveCount(0);
  await expect(page.getByTestId("composer-pill")).toBeVisible();
  await expect(page.getByTestId("bot-name-button")).toContainText("Ada");
  await expect(page.getByTestId("selected-bot-tile")).toContainText("Ada");
  await expect(page.getByTestId("bot-status-dot").first()).toBeVisible();
  await expect(page.locator(".sidebar-scroll")).toBeVisible();

  const pillRadius = await page.getByTestId("composer-pill").evaluate((node) => getComputedStyle(node).borderRadius);
  expect(Number.parseFloat(pillRadius)).toBeGreaterThan(20);
  const headerRadius = await page.getByTestId("bot-name-button").evaluate((node) => getComputedStyle(node).borderRadius);
  expect(headerRadius).toMatch(/9999px|px/);
  expect(Number.parseFloat(headerRadius)).toBeGreaterThan(16);

  const row = page.getByRole("link", { name: "Nova" });
  const menu = page.getByTestId("bot-row-menu").nth(1);
  await expect(menu).toHaveCSS("opacity", "0");
  await row.hover();
  await expect(menu).toHaveCSS("opacity", "1");
  await page.getByTestId("sidebar").screenshot({ path: `${dir}/light-row-hover.png` });

  await expect(page.getByTestId("notifications")).toBeVisible();
  await page.getByTestId("composer-pill").screenshot({ path: `${dir}/light-composer.png` });
  await page.getByTestId("bot-name-button").screenshot({ path: `${dir}/light-header-pill.png` });

  await page.mouse.move(900, 40);
  const scroll = page.locator(".sidebar-scroll");
  const restThumb = await scroll.evaluate((node) => getComputedStyle(node).scrollbarColor);
  expect(restThumb.replace(/\s+/g, " ")).toMatch(/transparent|rgba\(0,\s*0,\s*0,\s*0\)/);
  await scroll.evaluate((node) => {
    const list = node.querySelector("ul");
    const sample = list?.firstElementChild;
    if (!list || !sample) return;
    for (let i = 0; i < 14; i += 1) list.appendChild(sample.cloneNode(true));
  });
  await scroll.hover();
  await scroll.evaluate((node) => node.setAttribute("data-scrolling", "true"));
  const hotThumb = await scroll.evaluate((node) => getComputedStyle(node).scrollbarColor);
  expect(hotThumb).not.toBe(restThumb);
  await scroll.screenshot({ path: `${dir}/light-scrollbar.png` });
  await scroll.evaluate((node) => {
    node.removeAttribute("data-scrolling");
    const list = node.querySelector("ul");
    while (list && list.children.length > 2) list.lastElementChild?.remove();
  });

  await page.getByTestId("sidebar").screenshot({ path: `${dir}/light-footer-rest.png` });
  await page.getByTestId("sidebar-footer").screenshot({ path: `${dir}/hover-frame-1-rest.png` });
  const apps = page.getByTestId("open-plugins");
  await page.getByTestId("sidebar-footer").hover();
  await page.waitForTimeout(120);
  await page.getByTestId("sidebar-footer").screenshot({ path: `${dir}/hover-frame-2-mid.png` });
  await page.waitForTimeout(200);
  await page.getByTestId("sidebar-footer").screenshot({ path: `${dir}/hover-frame-3-expanded.png` });
  await expect(apps).toContainText("Connect apps");
  await expect(page.getByTestId("account-button")).toBeVisible();
  await shot(page, "light-sidebar");
  await page.getByTestId("sidebar").screenshot({ path: `${dir}/light-sidebar-footer.png` });

  await apps.click();
  await expect(page.getByTestId("plugins-modal")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connect apps" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByTestId("composer-add").click();
  await expect(page.getByRole("menuitem", { name: "Attach files" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Teach a task" })).toBeVisible();
  await page.keyboard.press("Escape");

  saved.theme = "dark";
  await page.goto(`/bots/${bot}?theme=dark`);
  await expect(page.locator("html")).not.toHaveClass(/light/);
  const footerBg = await page.getByTestId("account-button").evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(footerBg).not.toBe("rgb(255, 255, 255)");
  const composerBg = await page.getByTestId("composer-pill").evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(composerBg).not.toBe("rgb(255, 255, 255)");
  await shot(page, "dark-sidebar");
  await page.getByTestId("sidebar").screenshot({ path: `${dir}/dark-sidebar-footer.png` });
  await page.getByTestId("composer-pill").screenshot({ path: `${dir}/dark-composer.png` });
  await page.getByTestId("bot-name-button").screenshot({ path: `${dir}/dark-header-pill.png` });
  await page.getByTestId("sidebar-footer").screenshot({ path: `${dir}/dark-hover-frame-1-rest.png` });
  await page.getByTestId("sidebar-footer").hover();
  await page.waitForTimeout(120);
  await page.getByTestId("sidebar-footer").screenshot({ path: `${dir}/dark-hover-frame-2-mid.png` });
  await page.waitForTimeout(200);
  await page.getByTestId("sidebar-footer").screenshot({ path: `${dir}/dark-hover-frame-3-expanded.png` });
  await expect(page.getByTestId("open-plugins")).toContainText("Connect apps");
  await page.mouse.move(640, 280);
  await page.waitForTimeout(250);

  await page.setViewportSize({ width: 1024, height: 576 });
  await shot(page, "dark-1024");
  saved.theme = "light";
  await page.goto(`/bots/${bot}?theme=light`);
  await expect(page.locator("html")).toHaveClass(/light/);
  await shot(page, "light-1024");
  await page.setViewportSize({ width: 1440, height: 900 });
  await shot(page, "light-1440");
  saved.theme = "dark";
  await page.goto(`/bots/${bot}?theme=dark`);
  await expect(page.locator("html")).not.toHaveClass(/light/);
  await shot(page, "dark-1440");
});
