import fs from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

const shots = "/workspace/shots-rich-ui";
async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate((value: "light" | "dark") => {
    localStorage.setItem("teammates-theme", value);
    document.documentElement.classList.toggle("light", value === "light");
    document.documentElement.dataset.theme = value;
  }, theme);
  await page.reload();
}

test("renders every structured widget and keeps heavy widgets lazy", async ({ page }: { page: Page }) => {
  test.setTimeout(120_000);
  fs.mkdirSync(shots, { recursive: true });
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/dev/widgets");
  for (const type of ["card", "list", "table", "form", "buttons", "badges", "key-value", "progress", "image-grid", "chart", "flow", "code"]) {
    await expect(page.getByTestId(`widget-${type}`)).toBeVisible();
  }
  await expect(page.getByText("Open review")).toBeVisible();
  await page.getByLabel("Note *").fill("Keep the recap concise");
  await expect(page.getByTestId("widget-chart")).toBeVisible();
  await expect(page.getByTestId("widget-flow")).toBeVisible();
  const codeWidget = page.getByTestId("widget-code-editor");
  await expect(codeWidget).toHaveCount(1);
  await expect(codeWidget.locator(".monaco-editor").first()).toBeVisible();
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    await expect(page.getByTestId("widgets-gallery")).toBeVisible();
    await page.screenshot({ path: `${shots}/01-widgets-${theme}.png` });
  }
});

test("admin analytics chart loads on the usage page", async ({ page }: { page: Page }) => {
  test.setTimeout(60_000);
  fs.mkdirSync(shots, { recursive: true });
  await login(page);
  await page.route("**/api/admin/usage", route => route.fulfill({ json: [{ username: "Owner", modelCalls: 14 }, { username: "Teammate", modelCalls: 8 }] }));
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    await page.goto("/settings/usage");
    await expect(page.getByRole("tab", { name: /Usage/ })).toBeVisible();
    const chart = page.getByTestId("admin-analytics-chart");
    await expect(chart).toBeVisible();
    await page.screenshot({ path: `${shots}/02-admin-analytics-${theme}.png` });
  }
});

test("mock bot streams all widget types and gates widget actions", async ({ page }: { page: Page }) => {
  test.setTimeout(1_200_000);
  await login(page);
  const created = await page.request.post("/api/bots", { data: { name: `WidgetE2E ${Date.now()}`, role: "Widget demo teammate" } });
  expect(created.ok()).toBeTruthy();
  const bot = await created.json() as { id: string };
  try {
    const workspace = await page.request.get(`/api/bots/${bot.id}/workspace`).then(r => r.json()) as { conversationId: string };
    const types = ["card", "list", "table", "form", "buttons", "badges", "key-value", "progress", "image-grid", "chart", "flow", "code", "approval"];
    for (const type of types) {
      const response = await page.request.post(`/api/conversations/${workspace.conversationId}/messages`, { data: { content: `WIDGET_DEMO:${type}` } });
      expect(response.ok()).toBeTruthy();
      const submitted = await response.json() as { taskId: string };
      const started = Date.now();
      let status = "queued";
      while (Date.now() - started < 90_000 && !["completed", "failed"].includes(status)) {
        const tasks = await page.request.get(`/api/bots/${bot.id}/tasks`).then(r => r.json()) as Array<{ id: string; status: string }>;
        status = tasks.find(t => t.id === submitted.taskId)?.status ?? "queued";
        if (!["completed", "failed"].includes(status)) await page.waitForTimeout(500);
      }
      expect(status, `mock widget ${type}`).toBe("completed");
    }
    await page.goto(`/bots/${bot.id}`);
    for (const type of types.filter(t => t !== "approval")) await expect(page.getByTestId(`widget-${type}`).last()).toBeVisible();
    await page.locator('[data-widget-id="demo-buttons"]').getByRole("button", { name: "Continue" }).click();
    await expect.poll(async () => (await page.request.get(`/api/bots/${bot.id}/tasks`).then(r => r.json()) as Array<{ title?: string; status: string }>).filter(t => t.title?.includes("Widget action") && t.status === "completed").length >= 1, { timeout: 90_000 }).toBeTruthy();
    await expect(page.getByText("Widget action received.")).toBeVisible();
    await page.locator('[data-widget-id="demo-form"]').getByLabel("Note").fill("E2E form submission");
    await page.locator('[data-widget-id="demo-form"]').getByRole("button", { name: "Save" }).click();
    await expect.poll(async () => (await page.request.get(`/api/bots/${bot.id}/tasks`).then(r => r.json()) as Array<{ title?: string; status: string }>).filter(t => t.title?.includes("Widget action") && t.status === "completed").length >= 2, { timeout: 90_000 }).toBeTruthy();
    await page.locator('[data-widget-id="demo-approval"]').getByRole("button", { name: "Approve delete" }).click();
    await expect.poll(async () => {
      const data = await page.request.get(`/api/bots/${bot.id}/workspace`).then(r => r.json()) as { approvals: Array<{ action: string; status: string }> };
      return data.approvals.some(a => a.action === "widget_action" && a.status === "pending");
    }).toBeTruthy();
  } finally {
    await page.request.delete(`/api/bots/${bot.id}`);
  }
});
