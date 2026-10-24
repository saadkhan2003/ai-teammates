import { expect, test } from "@playwright/test";
import { createBot } from "./helpers";

// Background jobs in the computer view: live list, read-only log tail, Stop, and the background pill.
test("computer view lists a background job, tails its log and stops it", async ({ page }) => {
  test.setTimeout(180_000);
  const bot = await createBot(page, `Jobs ${Date.now().toString(36)}`);
  try {
    const ws = await page.request.get(`/api/bots/${bot.id}/workspace`).then(r => r.json());
    const sent = await page.request.post(`/api/conversations/${ws.conversationId}/messages`, { data: { content: "JOB LONG DEMO", client_id: crypto.randomUUID() } });
    expect(sent.ok()).toBeTruthy();
    await expect.poll(async () => {
      const body = await page.request.get(`/api/bots/${bot.id}/jobs`).then(r => r.json());
      return body.running;
    }, { timeout: 90_000 }).toBe(1);

    await page.goto(`/bots/${bot.id}`);
    await expect(page.getByTestId("bot-name-button")).toBeVisible();
    if ((await page.getByTestId("bot-name-button").getAttribute("aria-expanded")) !== "true") await page.getByTestId("bot-name-button").click();
    const jobs = page.getByTestId("computer-jobs").first();
    await expect(jobs).toBeVisible({ timeout: 30_000 });
    const row = jobs.getByTestId("job-row").filter({ hasText: "Long demo" });
    await expect(row.getByTestId("job-status")).toHaveText("Running");
    const before = await row.getByTestId("job-elapsed").textContent();
    await page.waitForTimeout(2200);
    await expect(row.getByTestId("job-elapsed")).not.toHaveText(before ?? "");

    const state = await page.request.get(`/api/bots/${bot.id}/jobs`).then(r => r.json());
    const lastUsed = state.screenLastUsedAt ? Date.parse(state.screenLastUsedAt) : 0;
    if (Date.now() - lastUsed > 120_000) await expect(jobs.getByTestId("background-pill")).toContainText("Working in background");
    if (state.screenLastUsedAt) await expect(jobs.getByTestId("screen-last-used")).toContainText(/Screen last used/);

    await row.getByTestId("job-open").click();
    const log = row.getByTestId("job-log");
    await expect(log).toContainText("working", { timeout: 15_000 });
    expect(await log.evaluate(el => el.tagName)).toBe("PRE");
    await expect(page.locator("[data-testid=job-log] input, [data-testid=job-log] textarea")).toHaveCount(0);

    await row.getByTestId("job-stop").click();
    await expect(row.getByTestId("job-stop")).toHaveText("Confirm stop");
    await row.getByTestId("job-stop").click();
    await expect(row.getByTestId("job-status")).toHaveText("Stopped", { timeout: 30_000 });
    await expect(jobs.getByTestId("background-pill")).toHaveCount(0);
    const text = (await page.locator("body").innerText()).toLowerCase();
    for (const banned of ["openrouter", "anthropic", "openai", "claude", "gpt-", "gemini"]) expect(text).not.toContain(banned);
  } finally {
    await page.request.delete(`/api/bots/${bot.id}`);
  }
});
