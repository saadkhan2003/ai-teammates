import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const owner = process.env.OWNER_USERNAME ?? "saad";
const password = process.env.OWNER_PASSWORD ?? "teammates-dev";
const tabs = ["Overview", "Computer", "Routines", "Files/Media", "Skills", "Memory", "Tasks", "Plugins"] as const;
const pages = ["/", "/settings", "/settings/secrets", "/settings/computer", "/settings/usage", "/system", "/invite"] as const;

function psql(sql: string) {
  const args = ["exec", "-i", "teammates-postgres-1", "psql", "-U", "agent", "-d", "agent", "-v", "ON_ERROR_STOP=1", "-c", sql];
  let result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.error || result.status !== 0) result = spawnSync("sudo", ["docker", ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "psql failed");
}

async function noHorizontalScroll(page: Page) {
  const extra = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(extra).toBeLessThanOrEqual(1);
}

async function openPane(page: Page, tab: (typeof tabs)[number]) {
  const pane = page.getByTestId("info-pane");
  if (!(await pane.isVisible().catch(() => false))) await page.getByTestId("bot-name-button").click();
  await expect(pane).toBeVisible();
  const trigger = pane.getByRole("tab", { name: tab, exact: true });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  await expect(trigger).toHaveAttribute("data-state", "active");
}

test.describe.configure({ mode: "serial", timeout: 240_000 });

test("phone layout, events, and live desktop", async ({ page }, testInfo) => {
  const project = testInfo.project.name;
  const dir = "/workspace/docs/evidence/mobile";
  fs.mkdirSync(dir, { recursive: true });
  const shot = async (name: string) => {
    if (project !== "iphone-13" && !(project === "android-360" && name === "chat")) return;
    const theme = await page.locator("html").evaluate((node) => (node.classList.contains("light") ? "light" : "dark"));
    await page.screenshot({ path: `${dir}/${project}-${theme}-${name}.png` });
  };

  await page.goto("/login");
  const viewport = await page.locator('meta[name="viewport"]').getAttribute("content");
  expect(viewport).toContain("width=device-width");
  expect(viewport).toContain("initial-scale=1");
  expect(viewport).toContain("viewport-fit=cover");
  const themeMeta = await page.locator('meta[name="theme-color"]').evaluateAll((nodes) =>
    nodes.map((node) => ({ media: node.getAttribute("media"), content: node.getAttribute("content") })),
  );
  expect(themeMeta.map((item) => item.media)).toEqual(
    expect.arrayContaining(["(prefers-color-scheme: light)", "(prefers-color-scheme: dark)"]),
  );
  await noHorizontalScroll(page);
  const card = await page.getByTestId("login-card").boundingBox();
  expect(card!.width).toBeGreaterThan((page.viewportSize()?.width ?? 0) * 0.7);
  await shot("login");

  await page.getByTestId("login-username").fill(owner);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await noHorizontalScroll(page);
  await shot("home");

  await page.getByTestId("sidebar-toggle").click();
  await expect(page.getByTestId("sidebar")).toBeVisible();
  await expect(page.getByTestId("new-bot")).toBeVisible();
  const toggle = await page.getByTestId("sidebar-toggle").boundingBox();
  expect(toggle!.height).toBeGreaterThanOrEqual(44);
  await page.getByTestId("sidebar").getByRole("link").filter({ hasText: "Clerk" }).first().click();
  await expect(page.getByTestId("composer")).toBeVisible();
  await noHorizontalScroll(page);

  const shellHeight = await page.getByTestId("app-shell").evaluate((node) => Math.round(node.getBoundingClientRect().height));
  const visualHeight = await page.evaluate(() => Math.round(window.visualViewport?.height ?? 0));
  expect(Math.abs(shellHeight - visualHeight)).toBeLessThanOrEqual(2);
  const composer = await page.getByTestId("composer").boundingBox();
  expect(composer!.y + composer!.height).toBeLessThanOrEqual((page.viewportSize()?.height ?? 0) + 1);

  for (const tab of tabs) {
    await openPane(page, tab);
    const box = await page.getByTestId("info-pane").getByRole("tab", { name: tab, exact: true }).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await noHorizontalScroll(page);
    if (tab === "Overview" || tab === "Computer" || tab === "Plugins") await shot(`tab-${tab.toLowerCase()}`);
  }
  const tabList = page.getByRole("tablist", { name: "Bot details" });
  const tabOverflow = await tabList.evaluate((node) => node.scrollWidth - node.clientWidth);
  expect(tabOverflow).toBeGreaterThan(0);

  await openPane(page, "Computer");
  await expect(page.getByTestId("watch-only")).toBeVisible();
  await expect(page.getByTestId("computer-tab")).toHaveAttribute("data-desktop-mode", "view");
  await expect(page.getByTestId("vnc-status")).toHaveText("Connected", { timeout: 90_000 });
  await expect(page.locator("[data-testid=desktop-frame] canvas")).toHaveCount(1);
  await page.getByTestId("desktop-frame").evaluate((frame) => {
    const rect = frame.getBoundingClientRect();
    const down = (id: number, x: number, y: number) =>
      frame.dispatchEvent(new PointerEvent("pointerdown", { pointerId: id, pointerType: "touch", clientX: x, clientY: y, bubbles: true, cancelable: true }));
    const move = (id: number, x: number, y: number) =>
      frame.dispatchEvent(new PointerEvent("pointermove", { pointerId: id, pointerType: "touch", clientX: x, clientY: y, bubbles: true, cancelable: true }));
    down(1, rect.left + 40, rect.top + 40);
    down(2, rect.left + 80, rect.top + 40);
    move(2, rect.left + 180, rect.top + 40);
  });
  await expect.poll(async () => Number(await page.getByTestId("desktop-frame").getAttribute("data-zoom"))).toBeGreaterThan(1);
  await page.getByTestId("desktop-fit").click();
  await expect(page.getByTestId("desktop-frame")).toHaveAttribute("data-zoom", "1.00");
  await shot("computer");

  await page.getByTestId("take-control").click();
  await expect(page.getByText("The pointer is yours.")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("watch-only")).toBeHidden();
  await page.getByTestId("desktop-keyboard-toggle").click();
  await expect(page.getByTestId("desktop-keyboard")).toBeVisible();
  await page.getByTestId("desktop-fullscreen").click();
  await expect.poll(async () => page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
  await page.getByTestId("desktop-fullscreen").click();
  await page.getByTestId("hand-back").click();
  await expect(page.getByText("View only, until you take control.")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("watch-only")).toBeVisible();

  await page.getByTestId("info-pane-close").click();
  const marker = `mobile ping ${Date.now().toString().slice(-6)}`;
  const resumed: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/events")) resumed.push(request.headers()["last-event-id"] ?? "");
  });
  await expect(page.getByTestId("event-stream")).toHaveAttribute("data-state", "open");
  await page.getByTestId("composer").fill(marker);
  await page.getByTestId("send-chat").click();
  await expect(page.getByTestId("message-item").filter({ hasText: marker })).toBeVisible();
  await expect(page.getByTestId("event-stream")).not.toHaveAttribute("data-last-id", "");
  const lastId = await page.getByTestId("event-stream").getAttribute("data-last-id");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => resumed.includes(lastId ?? "")).toBe(true);
  await expect(page.getByTestId("event-stream")).toHaveAttribute("data-state", "open");
  await noHorizontalScroll(page);
  await shot("chat");

  const botId = new URL(page.url()).pathname.split("/").pop() ?? "";
  expect(botId).toMatch(/^[0-9a-f-]{36}$/i);
  psql(`INSERT INTO approvals (bot_id, action, target, reason, status) VALUES ('${botId}', 'send_email', 'ada@example.com', 'Mobile layout check', 'pending');`);
  await page.reload();
  const approvalCard = page.getByTestId("approval-card").filter({ hasText: "send_email" });
  await expect(approvalCard).toBeVisible();
  const approval = await approvalCard.boundingBox();
  expect(approval!.width).toBeGreaterThan((page.viewportSize()?.width ?? 0) * 0.7);
  await noHorizontalScroll(page);
  await shot("approval");
  psql("DELETE FROM approvals WHERE reason = 'Mobile layout check';");

  for (const path of pages) {
    await page.goto(path);
    await expect(page.locator("body")).toBeVisible();
    await noHorizontalScroll(page);
    if (path === "/settings/secrets") await shot("secrets");
  }

  await page.goto("/settings");
  await page.getByTestId("theme-light").click();
  await expect(page.locator("html")).toHaveClass(/light/);
  await expect.poll(async () => page.locator('meta[name="theme-color"]').first().getAttribute("content")).toBe("#fafafa");
  await page.goto("/login");
  await noHorizontalScroll(page);
  await shot("login");
  await page.goto("/");
  await shot("home");
  await page.goto("/settings");
  await page.getByTestId("theme-dark").click();
  await expect(page.locator("html")).not.toHaveClass(/light/);
  await expect.poll(async () => page.locator('meta[name="theme-color"]').first().getAttribute("content")).toBe("#141414");
});
