import { expect, test } from "@playwright/test";
import { login } from "./helpers";

async function openBot(page: import("@playwright/test").Page) {
  await login(page);
  const response = await page.request.post("/api/bots", { data: { name: `Retry ${Date.now().toString().slice(-5)}` } });
  const bot = (await response.json()) as { id: string };
  await page.goto(`/bots/${bot.id}`);
  await expect(page.getByTestId("composer")).toBeVisible();
  return bot.id;
}

test("couldn't refresh shows once in the sidebar and chat, retries by keyboard and clears", async ({ page }) => {
  const botId = await openBot(page);
  try {
    await expect(page.getByTestId("refresh-notice-sidebar")).toHaveCount(0);
    await page.route("**/api/**", route => route.abort());
    await page.evaluate(() => window.dispatchEvent(new Event("teammates-bots-changed")));
    await expect(page.getByTestId("refresh-notice-sidebar")).toHaveCount(1);
    await expect(page.getByTestId("refresh-notice-chat")).toHaveCount(1);
    await page.evaluate(() => window.dispatchEvent(new Event("teammates-bots-changed")));
    await expect(page.getByTestId("refresh-notice-sidebar")).toHaveCount(1);
    await expect(page.getByTestId("refresh-notice-chat")).toHaveCount(1);
    await page.screenshot({ path: "/workspace/ai-teammates-live/shots/6-couldnt-refresh.png" });

    // Still failing: the notice stays after a manual retry.
    await page.getByTestId("refresh-retry-chat").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("refresh-notice-chat")).toHaveCount(1);

    // Wait out the retry spin (the button is disabled while it runs) and focus it before the
    // network comes back: background polls such as learned notes clear the notice as soon as
    // one request succeeds, which would remove the button before the key press.
    await expect(page.getByTestId("refresh-retry-sidebar")).toBeEnabled();
    await page.getByTestId("refresh-retry-sidebar").focus();
    const bots = page.waitForResponse(r => r.url().endsWith("/api/bots") && r.request().method() === "GET");
    const history = page.waitForResponse(r => r.url().includes(`/api/bots/${botId}/workspace`));
    await page.unroute("**/api/**");
    await page.keyboard.press("Enter");
    await bots;
    await history;
    await expect(page.getByTestId("refresh-notice-sidebar")).toHaveCount(0);
    await expect(page.getByTestId("refresh-notice-chat")).toHaveCount(0);
  } finally {
    await page.unroute("**/api/**").catch(() => undefined);
    await page.request.delete(`/api/bots/${botId}`);
  }
});

test("going offline shows the notice and coming back online auto-recovers", async ({ page, context }) => {
  const botId = await openBot(page);
  try {
    await context.setOffline(true);
    await expect(page.getByTestId("refresh-notice-sidebar")).toHaveCount(1);
    await expect(page.getByTestId("refresh-notice-chat")).toHaveCount(1);
    await context.setOffline(false);
    await expect(page.getByTestId("refresh-notice-sidebar")).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId("refresh-notice-chat")).toHaveCount(0);
  } finally {
    await context.setOffline(false);
    await page.request.delete(`/api/bots/${botId}`);
  }
});

test("right panel shows its own couldn't refresh bar when offline, retries on click and fades out", async ({ page, context }) => {
  const botId = await openBot(page);
  try {
    const pane = page.getByTestId("info-pane");
    await expect(pane).toBeVisible();
    await expect(pane.getByTestId("refresh-notice-panel")).toHaveCount(0);
    await context.setOffline(true);
    const bar = pane.getByTestId("refresh-notice-panel");
    await expect(bar).toHaveCount(1);
    await expect(bar).toHaveAttribute("data-state", "visible");
    await expect(bar).toContainText("Couldn't refresh");
    // The bar is the first thing in the panel, above avatar, name and tabs.
    const barBox = await bar.boundingBox();
    const identityBox = await pane.getByTestId("panel-identity").boundingBox();
    expect(barBox && identityBox && barBox.y < identityBox.y).toBeTruthy();
    await page.screenshot({ path: "/workspace/ai-teammates-live/shots/9-panel-couldnt-refresh.png" });
    // Still offline: clicking Try again keeps the bar.
    await pane.getByTestId("refresh-retry-panel").click();
    await expect(bar).toHaveCount(1);
    await context.setOffline(false);
    await pane.getByTestId("refresh-retry-panel").click();
    await expect(bar).toHaveCount(0, { timeout: 15_000 });
  } finally {
    await context.setOffline(false);
    await page.request.delete(`/api/bots/${botId}`);
  }
});
