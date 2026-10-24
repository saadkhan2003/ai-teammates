import { expect, test } from "@playwright/test";

// The Usage & Billing page: weekly meter, on-demand dropdown, Manage Plan. Nothing is charged.
test("usage page shows one weekly meter, on-demand limit and plan upgrade", async ({ page }) => {
  const original = await page.request.get("/api/usage/credits").then(r => r.json());
  try {
    await page.goto("/settings/usage");
    const weekly = page.getByTestId("usage-weekly");
    await expect(weekly).toContainText("Weekly usage limit");
    await expect(page.getByTestId("usage-percent")).toHaveText(/^(<1|\d+)%$/);
    await expect(page.getByTestId("usage-resets")).toHaveText(/Resets (today|in \d+ days?)/);
    await expect(page.getByTestId("usage-breakdown")).toContainText("AI");
    await expect(page.getByTestId("usage-breakdown")).toContainText("Computer");
    await expect(page.getByTestId("usage-breakdown")).toContainText("Storage");
    await expect(page.getByText("Included usage with your subscription. Resets weekly.", { exact: false })).toBeVisible();
    const weight = await page.getByTestId("usage-billing").evaluate(el => getComputedStyle(el).fontWeight);
    expect(Number(weight)).toBeLessThanOrEqual(400);

    // Storage quota and per-computer memory from the plan limits.
    await expect(page.getByTestId("usage-storage")).toContainText("Storage");
    await expect(page.getByTestId("usage-storage-amount")).toHaveText(new RegExp(`of ${original.limits.storageQuotaGb} GB$`));
    await expect(page.getByTestId("usage-storage-note")).toContainText(original.storage.state === "ok" ? `warning at ${original.storage.warnPct}%` : "storage");
    if (original.computers?.length) await expect(page.getByTestId("usage-computer-ram").first()).toHaveText(/RAM$/);

    const select = page.getByTestId("usage-on-demand");
    await expect(select).toContainText(original.credits.onDemandLimitUsd ? `$${Number(original.credits.onDemandLimitUsd)}` : "None");
    await select.click();
    await page.getByRole("option", { name: "$10", exact: true }).click();
    await expect(page.getByText("On-demand limit set to $10 a month")).toBeVisible();
    await expect.poll(async () => (await page.request.get("/api/usage/credits").then(r => r.json())).credits.onDemandLimitUsd).toBe(10);
    await select.click();
    await page.getByRole("option", { name: "None", exact: true }).click();
    await expect(page.getByText("On-demand usage turned off")).toBeVisible();

    const plan = page.getByTestId("usage-plan");
    await expect(plan).toContainText(`Current plan: ${original.credits.planName}`);
    if (original.upgrade) {
      await page.getByTestId("usage-upgrade").click();
      await expect(page.getByText(/nothing has been charged/)).toBeVisible();
    }
    const text = (await page.locator("body").innerText()).toLowerCase();
    for (const banned of ["openrouter", "anthropic", "openai", "claude", "gpt-", "gemini", "model calls"]) expect(text).not.toContain(banned);
  } finally {
    await page.request.put("/api/usage/on-demand", { data: { limitUsd: original.credits.onDemandLimitUsd ?? null } });
  }
});

test("usage page explains a pause and how to top up", async ({ page }) => {
  await page.route("**/api/usage/credits", async route => {
    const real = await route.fetch();
    const body = await real.json();
    body.credits = { ...body.credits, percent: 100, paused: true, state: "paused", usedCredits: body.credits.allowance };
    body.message = "You've used all of this week's included usage, so new background jobs and waking the computer are paused. Chat still works. To keep going now, open Settings → Usage & Billing and choose an on-demand monthly limit.";
    await route.fulfill({ response: real, json: body });
  });
  await page.goto("/settings/usage");
  await expect(page.getByTestId("usage-paused")).toContainText("choose an on-demand monthly limit");
  await expect(page.getByTestId("usage-percent")).toHaveText("100%");
  await expect(page.getByTestId("usage-bar")).toHaveAttribute("style", /width: 100%/);
});

test("usage page warns when storage is nearly full and blocks at 100%", async ({ page }) => {
  let state: "warning" | "full" = "warning";
  await page.route("**/api/usage/credits", async route => {
    const real = await route.fetch();
    const body = await real.json();
    const quota = body.storage.quotaBytes;
    body.storage = state === "warning"
      ? { ...body.storage, usedBytes: Math.round(quota * 0.85), percent: 85, state, message: "You've used 85% of your storage (42.5 GB of 50 GB). At 100% new files can't be saved." }
      : { ...body.storage, usedBytes: quota, percent: 100, state, message: "Your storage is full (50 GB of 50 GB). New files can't be saved until you delete files or old downloads, or upgrade your plan in Settings → Usage." };
    await route.fulfill({ response: real, json: body });
  });
  await page.goto("/settings/usage");
  await expect(page.getByTestId("usage-storage-note")).toHaveAttribute("role", "status");
  await expect(page.getByTestId("usage-storage-note")).toContainText("85% of your storage");
  await expect(page.getByTestId("usage-storage-bar")).toHaveAttribute("style", /width: 85%/);
  state = "full";
  await page.reload();
  await expect(page.getByTestId("usage-storage-note")).toContainText("New files can't be saved");
  await expect(page.getByTestId("usage-storage-bar")).toHaveAttribute("style", /width: 100%/);
});
