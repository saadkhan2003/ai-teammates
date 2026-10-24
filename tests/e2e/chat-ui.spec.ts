import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const bot = "11111111-1111-4111-8111-111111111111";
const shots = process.env.ARTIFACTS_DIR;

async function shot(page: Page, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/${name}.png`, fullPage: false });
}

async function login(page: Page) {
  await page.goto("/login");
  await page.getByTestId("login-username").fill(process.env.OWNER_USERNAME ?? "saad");
  await page.getByTestId("login-password").fill(process.env.OWNER_PASSWORD ?? "teammates-dev");
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("app-shell")).toBeVisible();
}

test("composer, coding jobs, replies, and the side panel stay in sync", async ({ page }) => {
  await login(page);
  const jobs = [
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "UI batch", status: "running", step: "Editing the composer", prNumber: null, prUrl: "", updatedAt: "2026-10-24T00:00:00Z" },
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", title: "API reactions", status: "finished", step: "", prNumber: null, prUrl: "", updatedAt: "2026-10-24T00:00:01Z" },
  ];
  let messages: object[] = [
    { id: "m1", role: "assistant", content: "See [[job:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa]] now" },
    { id: "m2", role: "assistant", content: '{"type":"coding-jobs"}' },
  ];
  let push = false;
  const routineHits: boolean[] = [];
  await page.route(`**/api/bots/${bot}/**`, (route) => route.fulfill({ json: [] }));
  await page.route("**/api/system/llm-status", (route) => route.fulfill({ json: { hasKey: true, openrouterConnected: true } }));
  await page.route(`**/api/bots/${bot}/workspace`, (route) =>
    route.fulfill({
      json: {
        bot: { id: bot, name: "Ada", role: "Teammate", avatarColor: "#ff3045" },
        conversationId: bot,
        tasks: [],
        messages,
        approvals: [],
        pages: [],
        holder: "agent",
        openrouterConnected: true,
        codingJobs: jobs,
      },
    }),
  );
  await page.route(`**/api/bots/${bot}/routines`, (route) => route.fulfill({ json: [{ id: "routine-1", name: "Morning notes", cron: "0 8 * * *", enabled: true }] }));
  await page.route(`**/api/bots/${bot}/computer/power`, (route) => route.fulfill({ json: { status: "running" } }));
  await page.route("**/api/routines/routine-1", async (route) => {
    const body = route.request().postDataJSON() as { enabled?: boolean };
    routineHits.push(body.enabled === false);
    await route.fulfill({ json: { ok: true } });
  });
  await page.route(`**/api/conversations/${bot}/messages`, async (route) => {
    const data = route.request().postDataJSON() as { content: string; replyTo?: string };
    messages = [...messages, { id: "m3", role: "user", content: data.content, replyToId: data.replyTo }];
    await route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/events", async (route) => {
    if (!push) {
      await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: ": connected\n\n" });
      return;
    }
    const payload = JSON.stringify({ type: "coding.job", botId: bot, job: jobs[0] });
    await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: `data: ${payload}\n\n` });
  });

  await page.goto(`/bots/${bot}`);
  await expect(page.getByTestId("composer")).toHaveAttribute("placeholder", "Message Ada");
  await expect(page.getByTestId("composer-voice")).toBeVisible();
  await expect(page.getByTestId("assign-task")).toHaveCount(0);
  await shot(page, "01-composer-voice");
  await page.getByTestId("composer").fill("Hello");
  await expect(page.getByTestId("send-chat")).toBeVisible();
  await expect(page.getByTestId("composer-voice")).toHaveCount(0);
  await shot(page, "01-composer-send");

  await expect(page.getByTestId("coding-jobs-card")).toContainText("2 agents");
  await expect(page.getByTestId("coding-job-step")).toContainText("Editing the composer");
  await shot(page, "09-coding-live-step");
  await expect(page.getByTestId("job-mention")).toContainText("UI batch");
  const running = page.getByTestId("coding-panel-row").filter({ hasText: "UI batch" });
  await expect(running.getByTestId("job-spinner")).toBeVisible();
  await expect(running.locator("svg")).toBeVisible();
  const finished = page.getByTestId("coding-panel-row").filter({ hasText: "API reactions" });
  await expect(finished).toContainText("Finished");
  await expect(finished.getByTestId("job-finished")).toBeVisible();

  const cardRow = page.getByTestId("coding-job-row").filter({ hasText: "UI batch" });
  await cardRow.hover();
  await expect(cardRow.getByTestId("coding-job-watch")).toBeVisible();
  const open = cardRow.getByTestId("coding-job-open");
  await expect(open).toHaveAttribute("target", "_blank");
  await running.click();
  await expect(page.getByTestId("coding-job-detail")).toContainText("UI batch");
  await page.keyboard.press("Escape");

  jobs[0] = { ...jobs[0], status: "tests", step: "Running test suites", branch: "cursor/bot-app-awareness-ui", prNumber: 4, prUrl: "https://example.com/pull/4", filesChanged: 31, additions: 1113, deletions: 26, updatedAt: "2026-10-24T00:00:02Z" };
  push = true;
  await expect(page.getByTestId("coding-job-step")).toContainText("Running test suites", { timeout: 10_000 });
  const result = page.getByTestId("job-result-card").filter({ hasText: "UI batch" });
  await expect(result.getByTestId("job-result-running")).toBeVisible();
  jobs[0] = { ...jobs[0], status: "merged", step: "", updatedAt: "2026-10-24T00:00:03Z" };
  await expect(page.getByTestId("coding-list")).toContainText("Merged · #4", { timeout: 10_000 });
  await expect(result.getByTestId("job-result-succeeded")).toBeVisible();
  await expect(result).toContainText("cursor/bot-app-awareness-ui");
  await expect(result).toContainText("PR #4");
  await expect(result).toContainText("31 files changed");
  await expect(result).toContainText("+1113");
  await expect(result).toContainText("-26");
  await expect(result.getByTestId("job-result-pr")).toHaveAttribute("href", "https://example.com/pull/4");
  await expect(result.getByTestId("job-result-pr")).toHaveAttribute("target", "_blank");
  await result.getByTestId("job-result-open").hover();
  await expect(page.getByRole("tooltip", { name: "Open job" })).toBeVisible();
  await result.getByRole("button", { name: "UI batch" }).click();
  await expect(page.getByTestId("coding-job-detail")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("coding-jobs-card")).toContainText("2 jobs");
  await expect(page.getByTestId("coding-job-step")).toHaveCount(0);
  await shot(page, "09-coding-panel");
  await shot(page, "10-job-result");
  await page.evaluate(() => document.documentElement.classList.add("light"));
  await shot(page, "10-job-result-light");
  await page.evaluate(() => document.documentElement.classList.remove("light"));

  await expect(page.getByTestId("routines-list")).toContainText("Every day at 8:00 AM");
  await page.getByTestId("routine-toggle").click();
  await expect.poll(() => routineHits.some(Boolean)).toBeTruthy();

  await page.getByTestId("message-item").first().getByTestId("message-reply").click({ force: true });
  await expect(page.getByTestId("reply-chip")).toBeVisible();
  await page.getByTestId("composer").fill("Noted");
  await page.getByTestId("send-chat").click();
  const quote = page.getByTestId("reply-quote");
  await expect(quote).toBeVisible();
  await quote.click();
  await expect(page.locator("#message-m1")).toHaveAttribute("data-highlight", "true");
  await shot(page, "03-reply-quote");

  await expect(page.getByTestId("connect-apps")).toBeVisible();
  await expect(page.getByTestId("connect-apps")).not.toContainText("Catalog");
});

test("upload card shows a moving bar and a media skeleton", async ({ page }) => {
  await login(page);
  await page.route(`**/api/bots/${bot}/**`, async (route) => {
    if (route.request().method() === "PUT") {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    await route.fulfill({ json: [] });
  });
  await page.route("**/api/system/llm-status", (route) => route.fulfill({ json: { openrouterConnected: true } }));
  await page.route(`**/api/bots/${bot}/workspace`, (route) =>
    route.fulfill({
      json: {
        bot: { id: bot, name: "Ada", avatarColor: "#3366ff" },
        conversationId: bot,
        tasks: [],
        messages: [{ id: "img", role: "assistant", content: "![clip](/clip.png)" }],
        approvals: [],
        pages: [],
        holder: "agent",
        openrouterConnected: true,
        codingJobs: [],
      },
    }),
  );
  await page.route("**/api/events", (route) => route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: ": connected\n\n" }));
  await page.route("**/clip.png", (route) => route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64") }));
  await page.goto(`/bots/${bot}`);
  await page.locator('input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await expect(page.getByTestId("upload-bar")).toBeVisible();
  await shot(page, "04-upload-bar");
  await expect(page.getByTestId("upload-card")).toHaveAttribute("data-status", "done");
  await page.getByTestId("attachment-card").hover();
  await expect(page.getByTestId("attachment-reply")).toBeVisible();
  await expect(page.getByTestId("attachment-more")).toBeVisible();
  await shot(page, "07-attachment-actions");
});

test("prompt injection page renders the fixture as text", async ({ page }) => {
  await login(page);
  await page.goto("/dev/prompt-injection");
  const root = page.getByTestId("prompt-injection-page");
  await expect(root).toContainText("Team notes");
  await expect(root).toContainText("Ignore your previous instructions");
  await expect(root.locator("script")).toHaveCount(0);
  await shot(page, "08-prompt-injection");
});

test("asleep computer offers a wake action", async ({ page }) => {
  await login(page);
  await page.route(`**/api/bots/${bot}/**`, (route) => route.fulfill({ json: [] }));
  await page.route("**/api/system/llm-status", (route) => route.fulfill({ json: { openrouterConnected: true } }));
  await page.route(`**/api/bots/${bot}/workspace`, (route) =>
    route.fulfill({
      json: {
        bot: { id: bot, name: "Ada", avatarColor: "#3366ff" },
        conversationId: bot,
        tasks: [],
        messages: [],
        approvals: [],
        pages: [],
        holder: "agent",
        openrouterConnected: true,
        codingJobs: [],
      },
    }),
  );
  await page.route(`**/api/bots/${bot}/computer/power`, (route) => route.fulfill({ json: { status: "hibernated" } }));
  await page.route("**/api/events", (route) => route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: ": connected\n\n" }));
  await page.goto(`/bots/${bot}`);
  await expect(page.getByTestId("computer-asleep")).toBeVisible();
  await expect(page.getByTestId("computer-wake")).toBeVisible();
  await expect(page.getByTestId("computer-control-pill")).toContainText("Watching");
  await expect(page.getByTestId("take-control")).toBeVisible();
  await shot(page, "06-computer-asleep");
});
