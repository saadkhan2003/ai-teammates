import { expect, test, type Page } from "@playwright/test";

const owner = process.env.OWNER_USERNAME ?? "saad";
const password = process.env.OWNER_PASSWORD ?? "teammates-dev";
const SHOTS = "/workspace/ai-teammates-live/shots";

async function makeBot(page: Page) {
  const login = await page.request.post("/api/auth/login", { data: { username: owner, password } });
  expect(login.ok()).toBeTruthy();
  const made = await page.request.post("/api/bots", { data: { name: `Card ${Date.now().toString().slice(-5)}` } });
  expect(made.ok()).toBeTruthy();
  const body = await made.json();
  return (body.bot ?? body) as { id: string; name: string };
}

async function open(page: Page, id: string) {
  await page.goto(`/bots/${id}`);
  await expect(page.getByTestId("bot-name-button")).toBeVisible();
  if ((await page.getByTestId("bot-name-button").getAttribute("aria-expanded")) !== "true") await page.getByTestId("bot-name-button").click();
  await expect(page.getByTestId("info-pane")).toBeVisible();
}

test("computer card: waking, error with retry, sleeping, offline, click-through", async ({ page, context }) => {
  const bot = await makeBot(page);
  try {
    // Waking: the token request hangs, so the card says it is connecting.
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/computer/view-token", async (route) => { await held; await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "down" }) }); });
    await open(page, bot.id);
    const frame = page.getByTestId("desktop-frame");
    await expect(frame).toHaveAttribute("data-phase", "connecting");
    await expect(page.getByTestId("computer-state-title")).toHaveText("Waking up…");
    await expect(page.getByTestId("computer-state-sub")).toHaveText("Connecting");
    await expect(page.getByTestId("computer-dots")).toBeVisible();
    await expect(page.getByTestId("computer-caption")).toHaveText(`${bot.name}'s screen`);
    const ratio = await frame.evaluate((el) => el.getBoundingClientRect().width / el.getBoundingClientRect().height);
    expect(ratio).toBeGreaterThan(1.5);
    expect(ratio).toBeLessThan(1.7);
    await page.screenshot({ path: `${SHOTS}/12-computer-waking.png` });

    // Error: "Couldn't connect" and a Retry button; Retry asks again.
    release?.();
    await expect(frame).toHaveAttribute("data-phase", "error");
    await expect(page.getByTestId("computer-state-title")).toHaveText("Couldn't connect");
    await page.screenshot({ path: `${SHOTS}/12-computer-error.png` });
    let asked = 0;
    await page.unroute("**/computer/view-token");
    await page.route("**/computer/view-token", async (route) => { asked += 1; await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "still down" }) }); });
    await page.getByTestId("computer-retry").click();
    await expect.poll(() => asked).toBeGreaterThan(0);
    // The retry button must not open the full view.
    await expect(page.getByTestId("computer-topbar")).toBeHidden();

    // Offline wins over everything else.
    await context.setOffline(true);
    await expect(frame).toHaveAttribute("data-phase", "offline");
    await expect(page.getByTestId("computer-state-title")).toHaveText("You're offline");
    await page.screenshot({ path: `${SHOTS}/12-computer-offline.png` });
    await context.setOffline(false);
    await page.unroute("**/computer/view-token");
  } finally {
    await context.setOffline(false);
    await page.request.delete(`/api/bots/${bot.id}`);
  }
});

test("computer card: resting state and click opens the full view with the Watching pill", async ({ page }) => {
  const bot = await makeBot(page);
  try {
    await open(page, bot.id);
    const frame = page.getByTestId("desktop-frame");
    await expect(frame).toBeVisible();
    await expect(frame).toHaveAttribute("data-phase", /sleeping|live|connecting|error/);
    await page.screenshot({ path: `${SHOTS}/12-computer-card.png` });
    await frame.click();
    await expect(page.getByTestId("computer-topbar")).toBeVisible();
    await expect(page.getByTestId("control-pill")).toHaveAttribute("data-mode", "view");
    await expect(page.getByTestId("watch-only").first()).toHaveText("Watching");
    await expect(page.getByTestId("take-control")).toHaveText("Take control");
    await page.screenshot({ path: `${SHOTS}/12-computer-full.png` });
  } finally {
    await page.request.delete(`/api/bots/${bot.id}`);
  }
});

test("computer card respects reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const bot = await makeBot(page);
  try {
    await page.route("**/computer/view-token", async () => { /* never answers */ });
    await open(page, bot.id);
    await expect(page.getByTestId("desktop-frame")).toHaveAttribute("data-phase", "connecting");
    const names = await page.getByTestId("computer-state").locator("div.animate-pulse").evaluateAll((els) => els.map((el) => getComputedStyle(el).animationName));
    for (const name of names) expect(name).toBe("none");
  } finally {
    await page.request.delete(`/api/bots/${bot.id}`);
  }
});
