import { expect, test } from "@playwright/test";
import { login } from "./helpers";

async function openBot(page: import("@playwright/test").Page, color?: string) {
  await login(page);
  const response = await page.request.post("/api/bots", { data: { name: `Rout ${Date.now().toString().slice(-5)}`, ...(color ? { avatarColor: color } : {}) } });
  expect(response.ok()).toBeTruthy();
  const bot = (await response.json()) as { id: string };
  return bot.id;
}

function rgb(value: string): [number, number, number] {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

test("routines list shows schedule words and an accent-coloured switch that persists", async ({ page }) => {
  const botId = await openBot(page, "#ff3045");
  try {
    await page.request.post(`/api/bots/${botId}/routines`, { data: { name: "Morning brief with a very long name that must be truncated with an ellipsis", cron: "0 8 * * *", instruction: "brief" } });
    await page.request.post(`/api/bots/${botId}/routines`, { data: { name: "Weekly review", cron: "0 20 * * 0", instruction: "review" } });
    await page.request.post(`/api/bots/${botId}/routines`, { data: { name: "Odd one", cron: "0 9 1 6 *", instruction: "odd" } });
    await page.goto(`/bots/${botId}`);
    const section = page.getByTestId("routines-section");
    await expect(section).toBeVisible();
    await expect(section.getByTestId("routine-add")).toHaveCount(0);
    const rows = section.getByTestId("routine-row");
    await expect(rows).toHaveCount(3);
    await expect(section.getByText("Every day at 8:00 AM")).toBeVisible();
    await expect(section.getByText("Every Sunday at 8:00 PM")).toBeVisible();
    await expect(section.getByText("Custom schedule")).toBeVisible();
    await expect(section.getByText("No routines yet. Ask in chat to set one up.")).toHaveCount(0);
    const nameBox = await rows.first().locator("p").first().evaluate((el) => ({ overflow: getComputedStyle(el).textOverflow, clipped: el.scrollWidth > el.clientWidth }));
    expect(nameBox.overflow).toBe("ellipsis");
    expect(nameBox.clipped).toBe(true);

    const toggle = rows.nth(1).getByTestId("routine-toggle");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    const onColor = rgb(await toggle.evaluate((el) => getComputedStyle(el).backgroundColor));
    expect(onColor[0]).toBeGreaterThan(180);
    expect(onColor[1]).toBeLessThan(120);
    expect(onColor[2]).toBeLessThan(140);
    await page.screenshot({ path: "/workspace/ai-teammates-live/shots/10-routines-on.png" });

    await toggle.focus();
    await page.keyboard.press("Space");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect.poll(async () => {
      const list = (await (await page.request.get(`/api/bots/${botId}/routines`)).json()) as Array<{ name: string; enabled: boolean }>;
      return list.find((r) => r.name === "Weekly review")?.enabled;
    }).toBe(false);
    await expect.poll(async () => {
      const c = rgb(await toggle.evaluate((el) => getComputedStyle(el).backgroundColor));
      return Math.abs(c[0] - c[1]);
    }).toBeLessThan(40);
    await page.screenshot({ path: "/workspace/ai-teammates-live/shots/10-routines-off.png" });

    await rows.first().getByRole("button", { name: /Open Morning brief/ }).click();
    const drawer = page.getByTestId("routine-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText("Run history");
    await expect(drawer.getByText("No runs yet.")).toBeVisible();
    await drawer.getByRole("button", { name: "Test" }).click();
    await expect(page.getByText("Test run queued.")).toBeVisible();
    await expect.poll(async () => {
      const list = await (await page.request.get(`/api/bots/${botId}/routines`)).json() as Array<{ id: string; name: string }>;
      const id = list.find((routine) => routine.name.startsWith("Morning brief"))?.id;
      if (!id) return 0;
      const detail = await (await page.request.get(`/api/routines/${id}`)).json() as { runs?: unknown[] };
      return detail.runs?.length ?? 0;
    }, { timeout: 30_000 }).toBeGreaterThan(0);
    await drawer.getByRole("button", { name: "Close" }).click();
    await rows.first().getByRole("button", { name: /Open Morning brief/ }).click();
    await expect(drawer.getByTestId("routine-run").first()).toBeVisible();
    await drawer.getByRole("button", { name: "Edit" }).click();
    await expect(page.getByTestId("composer")).toHaveValue("Edit your routine: Morning brief with a very long name that must be truncated with an ellipsis");
    await page.setViewportSize({ width: 360, height: 780 });
    await rows.first().getByRole("button", { name: /Open Morning brief/ }).click();
    await expect(drawer).toBeVisible();
    expect(await drawer.evaluate((el) => el.getBoundingClientRect().right)).toBeLessThanOrEqual(360);
    await drawer.getByRole("button", { name: "Pause" }).click();
    await expect(drawer.getByTestId("routine-status")).toContainText("Paused");
    await drawer.getByRole("button", { name: "Resume" }).click();
    await expect(drawer.getByTestId("routine-status")).not.toContainText("Paused");
    page.once("dialog", (dialog) => dialog.accept());
    await drawer.getByRole("button", { name: "Delete" }).click();
    await expect(drawer).toHaveCount(0);
    await expect.poll(async () => (await page.request.get(`/api/bots/${botId}/routines`).then((r) => r.json()) as Array<{ name: string }>).some((r) => r.name.startsWith("Morning brief"))).toBe(false);

    await page.reload();
    await expect(page.getByTestId("routines-section").getByTestId("routine-row").nth(1).getByTestId("routine-toggle")).toHaveAttribute("aria-checked", "false");
    await page.getByTestId("routines-section").getByTestId("routine-row").nth(1).getByTestId("routine-toggle").click();
    await expect(page.getByTestId("routines-section").getByTestId("routine-row").nth(1).getByTestId("routine-toggle")).toHaveAttribute("aria-checked", "true");
  } finally {
    await page.request.delete(`/api/bots/${botId}`);
  }
});

test("routines section shows a skeleton, the empty state and a retryable error", async ({ page }) => {
  const botId = await openBot(page);
  try {
    let fail = true;
    let delay = true;
    await page.route(`**/api/bots/${botId}/routines`, async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      if (delay) await new Promise((resolve) => setTimeout(resolve, 1500));
      if (fail) return route.fulfill({ status: 500, contentType: "application/json", body: "{\"error\":\"boom\"}" });
      return route.continue();
    });
    await page.goto(`/bots/${botId}`);
    await expect(page.getByTestId("routines-skeleton")).toBeVisible();
    await expect(page.getByTestId("routines-error")).toBeVisible({ timeout: 15_000 });
    delay = false;
    fail = false;
    await page.getByTestId("routines-retry").click();
    await expect(page.getByTestId("routines-empty")).toContainText("No routines yet");
    await expect(page.getByTestId("routine-name")).toHaveCount(0);
  } finally {
    await page.unroute(`**/api/bots/${botId}/routines`).catch(() => undefined);
    await page.request.delete(`/api/bots/${botId}`);
  }
});
