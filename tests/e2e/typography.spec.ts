import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const bot = "11111111-1111-4111-8111-111111111111";
const dir = "/opt/cursor/artifacts/typography";

async function installApi(page: Page, theme: { value: "light" | "dark" }) {
  await page.addInitScript(() => {
    const chosen = sessionStorage.getItem("shot-theme") || "dark";
    localStorage.setItem("teammates-theme", chosen);
  });
  await page.route("**/api/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/api/events")) {
      await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: ": connected\n\n" });
      return;
    }
    if (url.includes("/api/auth/me")) {
      await route.fulfill({ json: { username: "saad", displayName: "Muhammad Saad Khan", avatarUrl: "", role: "owner", theme: theme.value } });
      return;
    }
    if (url.includes("/api/usage")) {
      await route.fulfill({ json: { modelCalls: 1280, costUsd: 4.25, latencyMs: 840 } });
      return;
    }
    if (url.includes("/api/quotas")) {
      await route.fulfill({ json: { bots: 2, maxBots: 10, secrets: 1, maxSecrets: 20, computers: 1, maxComputers: 3, memoryBytes: 268435456, cpuMillis: 1200 } });
      return;
    }
    if (url.includes("/api/admin/usage")) {
      await route.fulfill({ json: [{ id: "u1", username: "saad", role: "owner", modelCalls: 1280, costUsd: 4.25, latencyMs: 840 }] });
      return;
    }
    if (url.includes("/workspace")) {
      await route.fulfill({
        json: {
          bot: { id: bot, name: "Ada", role: "Teammate", status: "idle", avatarColor: "#3b6fd8" },
          conversationId: bot,
          tasks: [],
          approvals: [],
          pages: [],
          holder: "agent",
          openrouterConnected: true,
          codingJobs: [],
          messages: [
            { id: "m1", role: "user", content: "Draft a short update for the team.", createdAt: "2026-10-24T01:00:00Z" },
            { id: "m2", role: "assistant", content: "Here is a concise update: the footer avatar and type scale are the remaining polish items.", createdAt: "2026-10-24T01:01:00Z" },
          ],
        },
      });
      return;
    }
    if (url.includes("/artifacts") || url.includes("/routines") || url.includes("/memories") || url.includes("/skills")) {
      await route.fulfill({ json: [] });
      return;
    }
    if (url.includes("/files")) {
      await route.fulfill({
        json: [
          { path: "notes/overview.md", name: "overview.md", directory: false, updatedAt: "2026-10-24T08:00:00Z" },
          { path: "notes/brief.md", name: "Weekly brief.md", directory: false, updatedAt: "2026-10-23T08:00:00Z" },
          { path: "notes/plan.md", name: "Launch plan.md", directory: false, updatedAt: "2026-10-22T08:00:00Z" },
        ],
      });
      return;
    }
    if (url.includes("/api/bots")) {
      await route.fulfill({ json: [{ id: bot, name: "Ada", role: "Teammate", status: "idle", section: "Teammates" }] });
      return;
    }
    await route.fulfill({ json: [] });
  });
}

test("body font is Inter and chat text is 15px", async ({ page }) => {
  mkdirSync(dir, { recursive: true });
  const theme = { value: "dark" as "light" | "dark" };
  await installApi(page, theme);
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`/bots/${bot}?theme=dark`);
  await expect(page.getByTestId("message-bubble").first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const family = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  expect(family.replace(/^["']/, "")).toMatch(/^Inter/);
  const features = await page.evaluate(() => getComputedStyle(document.body).fontFeatureSettings);
  expect(features).toContain("cv11");
  expect(features).toContain("ss01");
  const bubble = page.getByTestId("message-bubble").first();
  const size = await bubble.evaluate((node) => getComputedStyle(node).fontSize);
  const line = await bubble.evaluate((node) => getComputedStyle(node).lineHeight);
  const weight = await bubble.evaluate((node) => getComputedStyle(node).fontWeight);
  const ink = await page.evaluate(() => getComputedStyle(document.body).color);
  const optical = await page.evaluate(() => getComputedStyle(document.body).fontOpticalSizing);
  const smoothing = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue("-webkit-font-smoothing"));
  expect(size).toBe("15px");
  expect(line).toBe("22px");
  expect(Number(weight)).toBeLessThanOrEqual(400);
  expect(ink).toBe("rgb(231, 233, 234)");
  expect(optical).toBe("auto");
  expect(smoothing === "antialiased" || smoothing === "").toBe(true);
  const nameWeight = await page.locator("[data-testid='sidebar'] a").filter({ hasText: "Ada" }).first().evaluate((node) => {
    const label = node.querySelector("span.truncate") || node;
    return Number(getComputedStyle(label).fontWeight);
  });
  expect(nameWeight).toBeGreaterThanOrEqual(440);
  expect(nameWeight).toBeLessThanOrEqual(460);
  const previewWeight = await page.locator("[data-testid='sidebar']").getByText("Teammate", { exact: true }).first().evaluate((node) => Number(getComputedStyle(node).fontWeight));
  expect(previewWeight).toBeLessThanOrEqual(400);
  const loaded = await page.evaluate(() => [...document.fonts].some((face) => face.family.replace(/["']/g, "").startsWith("Inter") && face.status === "loaded"));
  expect(loaded).toBe(true);
  await expect(page.getByTestId("info-pane")).toBeHidden();
  await expect(page.getByTestId("artifact-card")).toHaveCount(0);
  await page.screenshot({ path: `${dir}/after-chat-closed.png` });
  await page.getByTestId("bot-name-button").click();
  await expect(page.getByTestId("info-pane")).toBeVisible();
  await expect.poll(async () => page.locator(`[data-bot-id="${bot}"]`).evaluateAll((nodes) => [...new Set(nodes.map((node) => node.getAttribute("data-avatar-fill")))].join(","))).toBe("#3b6fd8");
  const tablist = page.getByRole("tablist", { name: "Bot details" });
  const fit = await tablist.evaluate((node) => node.scrollWidth - node.clientWidth);
  expect(fit).toBeLessThanOrEqual(1);
  const computer = tablist.getByRole("tab", { name: "Computer", exact: true });
  const inside = await computer.evaluate((node) => {
    const tab = node.getBoundingClientRect();
    const list = node.parentElement?.getBoundingClientRect();
    return Boolean(list && tab.right <= list.right + 1 && tab.left >= list.left - 1);
  });
  expect(inside).toBe(true);
  const clipped = await computer.evaluate((node) => node.scrollWidth - node.clientWidth);
  expect(clipped).toBeLessThanOrEqual(1);
  const tabMetrics = await computer.evaluate((node) => {
    const list = node.parentElement;
    const style = list ? getComputedStyle(list) : null;
    return {
      height: Math.round(node.getBoundingClientRect().height),
      pad: style?.paddingTop ?? "",
      size: getComputedStyle(node).fontSize,
      weight: Number(getComputedStyle(node).fontWeight),
    };
  });
  expect(tabMetrics.height).toBe(28);
  expect(tabMetrics.pad).toBe("3px");
  expect(tabMetrics.size).toBe("13px");
  expect(tabMetrics.weight).toBeGreaterThanOrEqual(490);
  expect(tabMetrics.weight).toBeLessThanOrEqual(510);
  const connect = page.getByTestId("connect-apps").getByRole("button", { name: "Connect apps" });
  await expect(connect).toBeVisible();
  await expect(connect).toContainText("Connect apps");
  const pane = page.getByTestId("info-pane");
  const inset = await pane.evaluate((node) => {
    const list = node.querySelector("[role='tablist']");
    const card = node.querySelector(".panel-card");
    const content = card?.closest("[role='tabpanel']");
    const listBox = list?.getBoundingClientRect();
    const cardBox = card?.getBoundingClientRect();
    return {
      tab: list ? getComputedStyle(list).marginLeft : "",
      tabRight: list ? getComputedStyle(list).marginRight : "",
      card: content ? getComputedStyle(content).paddingLeft : "",
      aligned: Boolean(listBox && cardBox && Math.abs(listBox.left - cardBox.left) <= 1 && Math.abs(listBox.right - cardBox.right) <= 1),
    };
  });
  expect(inset.tab).toBe("16px");
  expect(inset.tabRight).toBe("16px");
  expect(inset.card).toBe("16px");
  expect(inset.aligned).toBe(true);
  const rhythm = await pane.evaluate((node) => {
    const sections = [...node.querySelectorAll("section")].filter((section) => section.querySelector("h2") && section.offsetParent);
    const gaps = sections.map((section) => {
      const heading = section.querySelector("h2");
      const card = section.querySelector(".panel-card");
      if (!heading || !card) return null;
      return Math.round(card.getBoundingClientRect().top - heading.getBoundingClientRect().bottom);
    }).filter((gap): gap is number => gap !== null);
    const stacks = sections.slice(1).map((section, index) => Math.round(section.getBoundingClientRect().top - sections[index].getBoundingClientRect().bottom));
    return { gaps, stacks };
  });
  expect(rhythm.gaps.length).toBeGreaterThan(1);
  expect(rhythm.gaps.every((gap) => gap === 8)).toBe(true);
  expect(rhythm.stacks.every((gap) => gap === 24)).toBe(true);
  await page.screenshot({ path: `${dir}/after-chat-open.png` });
  await page.getByRole("tab", { name: "Library", exact: true }).click();
  await expect(page.getByText("overview.md")).toBeVisible();
  const libraryWeight = await page.getByText("overview.md").evaluate((node) => Number(getComputedStyle(node).fontWeight));
  expect(libraryWeight).toBeLessThanOrEqual(400);
  const rowHeight = await page.getByTestId("library-row").first().evaluate((node) => Math.round(node.getBoundingClientRect().height));
  expect(rowHeight).toBe(36);
  await expect(page.getByText("Workspace path")).toHaveCount(0);
  await expect(page.getByText("Ada", { exact: true }).locator("xpath=ancestor::*[@data-testid='library-row']")).toHaveCount(0);
  await page.getByTestId("sidebar").screenshot({ path: `${dir}/crop-sidebar-dark.png` });
  await page.getByTestId("message-item").first().screenshot({ path: `${dir}/crop-bubble-dark.png` });
  await page.getByTestId("info-pane").screenshot({ path: `${dir}/crop-library-dark.png` });
  const memory = page.getByRole("tab", { name: "Memory", exact: true });
  await memory.scrollIntoViewIfNeeded();
  const memoryInside = await memory.evaluate((node) => {
    const tab = node.getBoundingClientRect();
    const list = node.parentElement?.getBoundingClientRect();
    return Boolean(list && tab.right <= list.right + 1 && tab.left >= list.left - 1 && tab.width > 40);
  });
  expect(memoryInside).toBe(true);
  await page.getByRole("tab", { name: "Details", exact: true }).click();
  theme.value = "light";
  await page.evaluate(() => sessionStorage.setItem("shot-theme", "light"));
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/light/);
  const lightInk = await page.evaluate(() => getComputedStyle(document.body).color);
  expect(lightInk).toBe("rgb(29, 33, 37)");
  const lightWeight = await page.getByTestId("message-bubble").first().evaluate((node) => Number(getComputedStyle(node).fontWeight));
  expect(lightWeight).toBeLessThanOrEqual(400);
  await page.getByTestId("bot-name-button").click();
  await expect(page.getByTestId("info-pane")).toBeVisible();
  await expect(page.getByTestId("connect-apps").getByRole("button", { name: "Connect apps" })).toBeVisible();
  await page.screenshot({ path: `${dir}/after-chat-open-light.png` });
  await page.getByRole("tab", { name: "Library", exact: true }).click();
  await expect(page.getByText("overview.md")).toBeVisible();
  await page.getByTestId("sidebar").screenshot({ path: `${dir}/crop-sidebar-light.png` });
  await page.getByTestId("message-item").first().screenshot({ path: `${dir}/crop-bubble-light.png` });
  await page.getByTestId("info-pane").screenshot({ path: `${dir}/crop-library-light.png` });
  await page.goto(`/settings?theme=dark`);
  await expect(page.getByTestId("settings-modal")).toBeVisible();
  await page.screenshot({ path: `${dir}/after-settings.png` });
  await page.goto(`/settings/usage?theme=dark`);
  await expect(page.getByText("Usage and billing")).toBeVisible();
  await page.screenshot({ path: `${dir}/after-billing.png` });
});
