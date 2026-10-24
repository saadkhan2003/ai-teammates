import { mkdirSync } from "node:fs";
import { expect, test, type Page, type Route } from "@playwright/test";

const bot = "11111111-1111-4111-8111-111111111111";
const copyId = "22222222-2222-4222-8222-222222222222";
const dir = "/opt/cursor/artifacts/right-panel";

const jobs = [
  { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "UI batch", status: "running", step: "Editing the composer", prNumber: null, prUrl: "", updatedAt: "2026-10-24T00:00:00Z" },
  { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", title: "API reactions", status: "finished", step: "", prNumber: 7, prUrl: "https://example.com/pull/7", updatedAt: "2026-10-24T00:00:01Z" },
  { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", title: "Merge the theme", status: "merged", step: "", prNumber: 4, prUrl: "https://example.com/pull/4", updatedAt: "2026-10-24T00:00:02Z" },
  { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", title: "Broken build", status: "failed", step: "", prNumber: null, prUrl: "", updatedAt: "2026-10-24T00:00:03Z" },
];

const routines = [
  { id: "routine-1", name: "ATLAS morning briefing", cron: "0 8 * * *", enabled: true },
  { id: "routine-2", name: "ATLAS weekly report", cron: "0 20 * * 0", enabled: true },
  { id: "routine-3", name: "Westake PhD reminder", cron: "x x * * *", enabled: false },
];

function shot(page: Page, name: string) {
  mkdirSync(dir, { recursive: true });
  return page.screenshot({ path: `${dir}/${name}.png` });
}

async function paneShot(page: Page, name: string) {
  mkdirSync(dir, { recursive: true });
  await page.getByTestId("info-pane").screenshot({ path: `${dir}/${name}.png` });
}

async function installApi(page: Page, options: { power: string; tasks: object[]; copyHits: string[] }) {
  const forbidden: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (/openrouter\.ai|api\.openai\.com|:18080\b/i.test(url)) forbidden.push(url);
  });
  await page.exposeBinding("__forbidden", () => forbidden);
  await page.route("**/api/**", async (route: Route) => {
    const url = route.request().url();
    const method = route.request().method();
    if (/openrouter|openai/i.test(url)) {
      await route.abort();
      return;
    }
    if (url.includes("/api/events")) {
      await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: ": connected\n\n" });
      return;
    }
    if (url.includes("/computer/power")) {
      await route.fulfill({ json: { status: options.power } });
      return;
    }
    if (url.includes("/computer/wake") && method === "POST") {
      options.power = "running";
      await route.fulfill({ json: { status: "running" } });
      return;
    }
    if (url.includes("/computer/take-control") && method === "POST") {
      await route.fulfill({ json: { token: "view-token", mode: "control" } });
      return;
    }
    if (url.includes("/computer/hand-back") && method === "POST") {
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (url.includes("/computer/view-token") && method === "POST") {
      await route.fulfill({ json: { token: "view-token", mode: "view" } });
      return;
    }
    if (url.endsWith("/api/bots") && method === "POST") {
      const body = route.request().postDataJSON() as { name?: string };
      options.copyHits.push(body.name ?? "");
      await route.fulfill({ json: { id: copyId, name: body.name } });
      return;
    }
    if (url.includes("/workspace")) {
      const id = url.includes(copyId) ? copyId : bot;
      await route.fulfill({
        json: {
          bot: {
            id,
            name: id === copyId ? "Ada copy" : "Ada",
            role: "Personal Chief of Staff",
            instructions: "Keeps the desk moving.",
            avatarShape: "blob1",
            avatarColor: "#ff3045",
          },
          conversationId: id,
          tasks: options.tasks,
          messages: [],
          approvals: [],
          pages: [],
          holder: "agent",
          llmProvider: "mock",
          openrouterConnected: true,
          codingJobs: jobs,
        },
      });
      return;
    }
    if (url.includes("/routines") && method === "GET") {
      await route.fulfill({ json: routines });
      return;
    }
    if (url.includes("/api/routines/") && method === "PATCH") {
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (url.includes("/api/auth/me")) {
      await route.fulfill({ json: { username: "Saad" } });
      return;
    }
    if (url.includes("/api/bots") && method === "GET") {
      await route.fulfill({ json: [{ id: bot, name: "Ada", role: "Personal Chief of Staff", avatarColor: "#ff3045", avatarShape: "blob1" }] });
      return;
    }
    await route.fulfill({ json: [] });
  });
}

async function showPane(page: Page) {
  const pane = page.getByTestId("info-pane");
  if (!(await pane.isVisible().catch(() => false))) await page.getByTestId("bot-name-button").click();
  await expect(pane).toBeVisible();
}

async function openBot(page: Page, theme: "light" | "dark") {
  await page.addInitScript((value) => {
    const chosen = sessionStorage.getItem("shot-theme") || value;
    localStorage.setItem("teammates-theme", chosen);
  }, theme);
  await page.goto(`/bots/${bot}`);
  await showPane(page);
  await showPane(page);
  await expect(page.locator("html")).toHaveClass(theme === "light" ? /light/ : /^((?!light).)*$/);
}

test("right panel identity, share menu, coding card, and routine toggles", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const options = { power: "running", tasks: [] as object[], copyHits: [] as string[] };
  await installApi(page, options);
  await openBot(page, "light");

  const pane = page.getByTestId("info-pane");
  await expect(pane.getByTestId("info-bot-name")).toHaveText("Ada");
  await expect(pane.getByTestId("info-bot-title")).toHaveText("Personal Chief of Staff");
  await expect(pane.getByTestId("info-identity").getByTestId("bot-avatar")).toBeVisible();
  const details = pane.getByRole("tab", { name: "Details", exact: true });
  await expect(details).toHaveAttribute("data-state", "active");
  const accent = await details.evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(accent).toBe("rgb(255, 255, 255)");
  await expect(pane.getByRole("tab", { name: "Library", exact: true })).toBeVisible();
  await expect(pane.getByRole("tab", { name: "Computer", exact: true })).toBeVisible();
  await paneShot(page, "light-01-identity-tabs");
  await shot(page, "light-01-identity-tabs-page");

  await page.getByTestId("info-share").click();
  await expect(page.getByTestId("share-create-copy")).toHaveText("Create a copy");
  await expect(page.getByTestId("share-template-link")).toHaveText("Share a template link");
  await shot(page, "light-02-share-menu");
  await page.getByTestId("share-create-copy").click();
  await expect.poll(() => options.copyHits).toEqual(["Ada copy"]);
  await expect(page).toHaveURL(new RegExp(`/bots/${copyId}`));
  await page.goto(`/bots/${bot}`);
  await showPane(page);
  await showPane(page);
  await page.getByTestId("info-share").click();
  await page.getByTestId("share-template-link").click();
  await expect(page.getByText("Template link copied.")).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain(`/bots/${bot}?template=1`);

  await expect(pane.getByTestId("coding-count")).toHaveText("4 agents");
  const running = pane.getByTestId("coding-panel-row").filter({ hasText: "UI batch" });
  await expect(running.getByTestId("job-spinner")).toBeVisible();
  const review = pane.getByTestId("coding-panel-row").filter({ hasText: "API reactions" });
  await expect(review).toContainText("Ready for review · #7");
  await expect(review.getByTestId("job-pr")).toBeVisible();
  await expect(pane.getByTestId("coding-panel-row").filter({ hasText: "Merge the theme" }).getByTestId("job-merged")).toBeVisible();
  await expect(pane.getByTestId("coding-panel-row").filter({ hasText: "Merge the theme" })).toContainText("Merged · #4");
  await expect(pane.getByTestId("coding-panel-row").filter({ hasText: "Broken build" }).getByTestId("job-failed")).toBeVisible();
  await review.hover();
  await expect(review.getByTestId("coding-job-watch")).toBeVisible();
  const open = review.getByTestId("coding-job-open");
  await expect(open).toBeVisible();
  await expect(open).toHaveAttribute("href", "https://example.com/pull/7");
  await expect(open).toHaveAttribute("target", "_blank");
  const openColor = await open.evaluate((node) => getComputedStyle(node).color);
  expect(openColor).toBe("rgb(255, 48, 69)");
  await review.getByTestId("coding-job-watch").hover();
  await expect(page.getByRole("tooltip", { name: "Watch" })).toBeVisible();
  await paneShot(page, "light-03-coding-hover");

  const toggle = pane.getByTestId("routine-toggle").first();
  await expect(pane.getByTestId("routines-list")).toContainText("Every day at 8:00 AM");
  await expect(pane.getByTestId("routines-list")).toContainText("Every Sunday at 8:00 PM");
  await expect(pane.getByTestId("routines-list")).toContainText("Custom schedule");
  const toggleColor = await toggle.evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(toggleColor).toBe("rgb(255, 48, 69)");
  await paneShot(page, "light-04-routines");

  await page.evaluate(() => sessionStorage.setItem("shot-theme", "dark"));
  await page.goto(`/bots/${bot}`);
  await showPane(page);
  await expect(page.locator("html")).not.toHaveClass(/light/);
  await expect(page.getByRole("tab", { name: "Details", exact: true })).toHaveAttribute("data-state", "active");
  const darkAccent = await page.getByRole("tab", { name: "Details", exact: true }).evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(darkAccent).toBe("rgb(24, 24, 24)");
  await paneShot(page, "dark-01-identity-tabs");
  await page.getByTestId("info-share").click();
  await expect(page.getByTestId("share-create-copy")).toBeVisible();
  await shot(page, "dark-02-share-menu");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("share-create-copy")).toBeHidden();
  await expect(page.getByTestId("info-pane")).toBeVisible();
  const darkReview = page.getByTestId("info-pane").getByTestId("coding-panel-row").filter({ hasText: "API reactions" });
  await darkReview.hover();
  await expect(darkReview.getByTestId("coding-job-open")).toBeVisible();
  await paneShot(page, "dark-03-coding-hover");
  const darkToggle = await page.getByTestId("routine-toggle").first().evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(darkToggle).toBe("rgb(255, 48, 69)");
  await paneShot(page, "dark-04-routines");
  const leaked = await page.evaluate(() => (window as unknown as { __forbidden?: () => string[] }).__forbidden?.() ?? []);
  expect(leaked).toEqual([]);
});

test("computer thumbnail, control pill, and sleep card", async ({ page }) => {
  const options = { power: "running", tasks: [] as object[], copyHits: [] as string[] };
  await installApi(page, options);
  await openBot(page, "light");
  await page.getByRole("tab", { name: "Computer", exact: true }).click();
  const thumb = page.getByTestId("computer-thumbnail");
  await expect(thumb).toBeVisible();
  await expect(page.getByTestId("computer-caption")).toHaveText("Ada's screen");
  await expect(page.getByTestId("computer-control-pill")).toContainText("Watching");
  await expect(page.getByTestId("take-control")).toHaveText("Take control");
  await thumb.hover();
  await expect(page.getByTestId("computer-open")).toBeVisible();
  await expect(page.getByTestId("computer-open")).toContainText("↗ Open");
  await paneShot(page, "light-05-thumbnail-hover");
  await shot(page, "light-07-watching");

  await page.getByTestId("computer-open").click();
  await expect(page.getByTestId("computer-tab")).toHaveClass(/fixed/);
  await expect(page.getByTestId("computer-open")).toBeHidden();
  await page.getByTestId("computer-close").click();
  await expect(page.getByTestId("computer-tab")).not.toHaveClass(/fixed/);

  await page.getByTestId("take-control").click();
  await expect(page.getByTestId("computer-control-pill")).toContainText("You're in control");
  await expect(page.getByTestId("hand-back")).toHaveText("Stop");
  await shot(page, "light-08-in-control");
  await page.getByTestId("hand-back").click();
  await expect(page.getByTestId("computer-control-pill")).toContainText("Watching");

  options.tasks = [{ id: "task-1", status: "waiting_human", title: "Sign in to the vendor" }];
  await page.goto(`/bots/${bot}`);
  await showPane(page);
  await page.getByRole("tab", { name: "Computer", exact: true }).click();
  await page.getByTestId("take-control").click();
  await expect(page.getByTestId("hand-back")).toHaveText("I'm done");
  await expect(page.getByTestId("attention-banner")).toBeVisible();
  await shot(page, "light-09-im-done");

  options.power = "hibernated";
  options.tasks = [];
  await page.goto(`/bots/${bot}`);
  await showPane(page);
  await page.getByRole("tab", { name: "Computer", exact: true }).click();
  await expect(page.getByTestId("computer-asleep")).toContainText("Computer is asleep");
  await expect(page.getByTestId("computer-asleep")).toContainText("z z");
  await expect(page.getByTestId("computer-wake")).toBeVisible();
  await expect(page.getByTestId("computer-caption")).toHaveText("Ada's screen");
  await paneShot(page, "light-06-sleep");
  await page.getByTestId("computer-wake").click();
  await expect(page.getByTestId("computer-asleep")).toBeHidden();
  await expect(page.getByTestId("computer-thumbnail")).toBeVisible();

  await page.evaluate(() => sessionStorage.setItem("shot-theme", "dark"));
  options.power = "running";
  await page.goto(`/bots/${bot}`);
  await showPane(page);
  await expect(page.locator("html")).not.toHaveClass(/light/);
  await page.getByRole("tab", { name: "Computer", exact: true }).click();
  await page.getByTestId("computer-thumbnail").hover();
  await expect(page.getByTestId("computer-open")).toBeVisible();
  await paneShot(page, "dark-05-thumbnail-hover");
  await shot(page, "dark-07-watching");
  await page.getByTestId("take-control").click();
  await expect(page.getByTestId("hand-back")).toHaveText("Stop");
  await shot(page, "dark-08-in-control");

  options.tasks = [{ id: "task-1", status: "waiting_human", title: "Sign in to the vendor" }];
  await page.goto(`/bots/${bot}`);
  await showPane(page);
  await page.getByRole("tab", { name: "Computer", exact: true }).click();
  await page.getByTestId("take-control").click();
  await expect(page.getByTestId("hand-back")).toHaveText("I'm done");
  await shot(page, "dark-09-im-done");

  options.power = "stopped";
  options.tasks = [];
  await page.goto(`/bots/${bot}`);
  await showPane(page);
  await page.getByRole("tab", { name: "Computer", exact: true }).click();
  await expect(page.getByTestId("computer-asleep")).toContainText("Computer is asleep");
  await paneShot(page, "dark-06-sleep");
});
