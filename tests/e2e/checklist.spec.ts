import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const bot = "11111111-1111-4111-8111-111111111111";
const dir = process.env.SHOT_DIR || "/tmp/ui-integrate-checklist";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function shot(page: Page, name: string) {
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${name}.png` });
}

async function login(page: Page) {
  await page.goto("/login");
  await page.getByTestId("login-username").fill(process.env.OWNER_USERNAME ?? "saad");
  await page.getByTestId("login-password").fill(process.env.OWNER_PASSWORD ?? "teammates-dev");
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("app-shell")).toBeVisible();
}

test("reactions toggle off, reply quote highlight, answered question, attachments, coding card, and connect apps", async ({ page }) => {
  await login(page);
  const jobs = [
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "UI batch", status: "running", step: "Editing the composer", prNumber: null, prUrl: "", updatedAt: "2026-10-24T00:00:00Z" },
    {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      title: "AI Teammates v0.4 bot self-update",
      status: "merged",
      step: "",
      branch: "cursor/bot-app-awareness-ui",
      prNumber: 6,
      prUrl: "https://example.com/pull/6",
      filesChanged: 31,
      additions: 1113,
      deletions: 26,
      updatedAt: "2026-10-24T00:00:01Z",
    },
  ];
  let reactions = [
    { id: "bot-like", emoji: "👍", actorType: "bot" },
    { id: "user-like", emoji: "👍", actorType: "user" },
  ];
  let messages: object[] = [
    { id: "m-react", role: "assistant", content: "Thanks for the review", reactions: [{ id: "self-like", emoji: "😂", actorType: "bot" }] },
    { id: "m-quote", role: "user", content: "Please keep the composer white.", reactions },
    {
      id: "m-question",
      role: "assistant",
      content: JSON.stringify({
        type: "question",
        prompt: "Which format should I use?",
        options: ["Standup notes", "Internal FAQ"],
        answer: ["Standup notes"],
      }),
    },
    { id: "m-file", role: "assistant", content: "![clip](/clip.png)" },
    { id: "m-mention", role: "assistant", content: "Watch [[job:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa]] while it runs." },
    { id: "m-jobs", role: "assistant", content: '{"type":"coding-jobs"}' },
  ];
  await page.route(`**/api/bots/${bot}/**`, (route) => route.fulfill({ json: [] }));
  await page.route("**/api/system/llm-status", (route) => route.fulfill({ json: { hasKey: true, openrouterConnected: true } }));
  await page.route("**/api/events", (route) => route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: ": connected\n\n" }));
  await page.route("**/clip.png", (route) => route.fulfill({ status: 200, contentType: "image/png", body: png }));
  await page.route("**/api/plugins/catalog**", (route) =>
    route.fulfill({ json: { items: [{ id: "github", name: "GitHub", kind: "mcp", authType: "oauth", category: "Code" }], total: 1, stats: { imported: 1 } } }),
  );
  await page.route(`**/api/bots/${bot}/routines`, (route) => route.fulfill({ json: [{ id: "routine-1", name: "Morning notes", cron: "0 8 * * *", enabled: true }] }));
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
  await page.route("**/api/messages/m-quote/reactions", async (route) => {
    reactions = reactions.filter((reaction) => reaction.actorType !== "user");
    const user = messages.find((message) => (message as { id: string }).id === "m-quote") as { reactions?: object[] };
    user.reactions = reactions;
    await route.fulfill({ json: { ok: true } });
  });
  await page.route(`**/api/conversations/${bot}/messages`, async (route) => {
    const data = route.request().postDataJSON() as { content: string; replyTo?: string };
    messages = [...messages, { id: "m-reply", role: "user", content: data.content, replyToId: data.replyTo }];
    await route.fulfill({ json: { ok: true } });
  });

  await page.goto(`/bots/${bot}`);
  await expect(page.getByTestId("composer-voice")).toBeVisible();
  await shot(page, "01-composer");
  const assistant = page.getByTestId("message-item").filter({ hasText: "Thanks for the review" });
  await expect(assistant.locator('[data-testid="reaction-pill"]')).toHaveCount(0);
  const userMessage = page.getByTestId("message-item").filter({ hasText: "Please keep the composer white." });
  const botPill = userMessage.locator('[data-testid="reaction-pill"][data-actor="bot"]');
  await expect(botPill).toBeVisible();
  const bubble = await userMessage.getByTestId("message-bubble").boundingBox();
  const cluster = await userMessage.getByTestId("reaction-cluster").boundingBox();
  expect(bubble && cluster).toBeTruthy();
  expect(cluster!.x + cluster!.width).toBeGreaterThan(bubble!.x + bubble!.width - 36);
  expect(cluster!.x + cluster!.width).toBeLessThanOrEqual(bubble!.x + bubble!.width + 4);
  expect(Math.abs(cluster!.y + cluster!.height / 2 - (bubble!.y + bubble!.height))).toBeLessThan(14);
  await botPill.hover();
  await expect(page.getByRole("tooltip", { name: "Ada reacted with 👍" })).toBeVisible();
  await shot(page, "02-reaction-tooltip");
  await page.locator('[data-testid="reaction-pill"][data-actor="user"]').click();
  await expect(page.locator('[data-testid="reaction-pill"][data-actor="user"]')).toHaveCount(0);
  await expect(botPill).toBeVisible();
  await shot(page, "02-reaction-toggled-off");

  await page.getByTestId("message-item").filter({ hasText: "Please keep the composer white." }).getByTestId("message-reply").click({ force: true });
  await expect(page.getByTestId("reply-chip")).toContainText("Please keep the composer white.");
  await shot(page, "03-reply-chip");
  await page.getByTestId("composer").fill("Noted");
  await page.getByTestId("send-chat").click();
  const quote = page.getByTestId("reply-quote");
  await expect(quote).toBeVisible();
  await quote.click();
  await expect(page.locator("#message-m-quote")).toHaveAttribute("data-highlight", "true");
  await page.locator("#message-m-quote").screenshot({ path: `${dir}/03-reply-highlight-close.png` });
  await shot(page, "03-reply-highlight");

  const answered = page.getByTestId("question-answered");
  await expect(answered).toContainText("Which format should I use?");
  await expect(answered).toContainText("Standup notes");
  await expect(page.getByTestId("question-card")).toHaveAttribute("data-answered", "true");
  await expect(page.getByRole("button", { name: "Standup notes", exact: true })).toHaveCount(0);
  await answered.scrollIntoViewIfNeeded();
  await shot(page, "07-question-answered");

  const attachment = page.getByTestId("attachment-card");
  await attachment.hover();
  await expect(page.getByTestId("message-reply")).toBeVisible();
  await page.getByTestId("message-more").click();
  await expect(page.getByRole("menuitem", { name: "Copy text" })).toBeVisible();
  await shot(page, "08-attachment-actions");
  await page.getByRole("menuitem", { name: "Copy link" }).click();

  await expect(page.getByTestId("job-mention")).toContainText("UI batch");
  const card = page.getByTestId("coding-jobs-card");
  const cardRow = card.getByTestId("coding-job-row").filter({ hasText: "UI batch" });
  await card.scrollIntoViewIfNeeded();
  await cardRow.hover();
  const watch = cardRow.getByTestId("coding-job-watch");
  await expect(watch).toBeVisible();
  await expect(cardRow.getByTestId("coding-job-open")).toBeVisible();
  await watch.hover();
  await expect(page.getByRole("tooltip", { name: "Watch" })).toBeVisible();
  await shot(page, "09-coding-card-hover");
  await card.screenshot({ path: `${dir}/09-coding-card-hover-close.png` });
  await expect(page.getByTestId("job-result-card")).toContainText("PR #6");
  await expect(page.getByTestId("job-result-card")).toContainText("31 files changed");
  const routines = page.getByTestId("routines-list");
  await routines.scrollIntoViewIfNeeded();
  await expect(page.getByTestId("routine-toggle")).toBeVisible();
  await routines.screenshot({ path: `${dir}/09-routines-toggle-close.png` });
  await shot(page, "09-routines-toggle");
  if (!(await page.getByTestId("info-pane").isVisible().catch(() => false))) await page.getByTestId("bot-name-button").click();
  await page.getByTestId("connect-apps").getByRole("button", { name: "Connect apps" }).click();
  await expect(page.getByTestId("plugins-modal")).toBeVisible();
  await page.getByTestId("connect-apps").screenshot({ path: `${dir}/08-connect-apps-close.png` });
  await shot(page, "08-connect-apps");
});

test("upload bar loops and image and video skeletons fade in", async ({ page }) => {
  await login(page);
  let releaseMedia = false;
  let releaseUpload = false;
  await page.route(`**/api/bots/${bot}/**`, async (route) => {
    if (route.request().method() === "PUT") {
      while (!releaseUpload) await new Promise((resolve) => setTimeout(resolve, 40));
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    await route.fulfill({ json: [] });
  });
  await page.route("**/api/system/llm-status", (route) => route.fulfill({ json: { openrouterConnected: true } }));
  await page.route("**/api/events", (route) => route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: ": connected\n\n" }));
  await page.route("**/media/clip.png", async (route) => {
    while (!releaseMedia) await new Promise((resolve) => setTimeout(resolve, 50));
    await route.fulfill({ status: 200, contentType: "image/png", body: png });
  });
  await page.route("**/media/clip.mp4", async (route) => {
    while (!releaseMedia) await new Promise((resolve) => setTimeout(resolve, 50));
    await route.fulfill({ status: 200, contentType: "image/png", body: png });
  });
  await page.route(`**/api/bots/${bot}/workspace`, (route) =>
    route.fulfill({
      json: {
        bot: { id: bot, name: "Ada", avatarColor: "#3366ff" },
        conversationId: bot,
        tasks: [],
        messages: [{ id: "media", role: "assistant", content: "![still](/media/clip.png)\n\n![reel](/media/clip.mp4)" }],
        approvals: [],
        pages: [],
        holder: "agent",
        openrouterConnected: true,
        codingJobs: [],
      },
    }),
  );
  await page.goto(`/bots/${bot}`);
  await expect(page.getByTestId("media-skeleton").first()).toBeVisible();
  await shot(page, "04-media-skeleton");
  releaseMedia = true;
  await expect(page.locator('[data-testid="attachment-card"] img')).toBeVisible();
  await expect(page.locator('[data-testid="attachment-card"]').first().getByTestId("media-skeleton")).toHaveCount(0);
  await shot(page, "04-media-fade-in");
  await page.locator('input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await expect(page.getByTestId("upload-bar")).toBeVisible();
  await page.getByTestId("upload-card").screenshot({ path: `${dir}/04-upload-bar-close.png` });
  await shot(page, "04-upload-bar");
  releaseUpload = true;
  await expect(page.getByTestId("upload-card")).toHaveAttribute("data-status", "done");
});

test("new-message pill and round jump button", async ({ page }) => {
  await login(page);
  const messages = Array.from({ length: 40 }, (_, index) => ({
    id: `old-${index}`,
    role: index % 2 ? "user" : "assistant",
    content: `Earlier note ${index}. This line is long enough to take space in the transcript.`,
  }));
  let release = false;
  await page.route(`**/api/bots/${bot}/**`, (route) => route.fulfill({ json: [] }));
  await page.route("**/api/system/llm-status", (route) => route.fulfill({ json: { openrouterConnected: true } }));
  await page.route("**/api/events", async (route) => {
    while (!release) await new Promise((resolve) => setTimeout(resolve, 40));
    await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: ": connected\n\n" });
  });
  await page.route(`**/api/bots/${bot}/workspace`, (route) =>
    route.fulfill({
      json: {
        bot: { id: bot, name: "Ada", avatarColor: "#ff3045" },
        conversationId: bot,
        tasks: [],
        messages,
        approvals: [],
        pages: [],
        holder: "agent",
        openrouterConnected: true,
        codingJobs: [],
      },
    }),
  );
  await page.goto(`/bots/${bot}`);
  await expect(page.getByTestId("message-item").first()).toBeVisible();
  const scroller = page.getByTestId("chat-scroll");
  await scroller.evaluate((node) => {
    node.scrollTop = 0;
    node.dispatchEvent(new Event("scroll"));
  });
  await expect(page.getByTestId("jump-to-latest")).toBeVisible();
  await expect(page.getByTestId("jump-to-latest")).toHaveAccessibleName("Jump to latest");
  messages.push({ id: "fresh-1", role: "assistant", content: "A brand new message arrived." });
  messages.push({ id: "fresh-2", role: "assistant", content: "And one more." });
  release = true;
  await page.evaluate(() => window.dispatchEvent(new Event("teammates-refresh")));
  await expect(page.getByTestId("new-messages")).toContainText("↓ 2 new messages");
  await expect(page.getByTestId("new-messages-pill")).toBeVisible();
  await shot(page, "05-new-messages");
  await page.getByRole("button", { name: "Dismiss new messages" }).click();
  await expect(page.getByTestId("new-messages")).toHaveCount(0);
  await expect(page.getByTestId("jump-to-latest")).toBeVisible();
  await shot(page, "05-jump-to-latest");
  await page.getByTestId("jump-to-latest").click();
  await expect(page.getByTestId("jump-to-latest")).toHaveCount(0);
  await expect(page.getByTestId("chat-message-list").getByText("And one more.")).toBeVisible();
});

test("asleep computer card offers wake", async ({ page }) => {
  await login(page);
  await page.route(`**/api/bots/${bot}/**`, (route) => route.fulfill({ json: [] }));
  await page.route("**/api/system/llm-status", (route) => route.fulfill({ json: { openrouterConnected: true } }));
  await page.route("**/api/events", (route) => route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: ": connected\n\n" }));
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
  await page.goto(`/bots/${bot}`);
  if (!(await page.getByTestId("info-pane").isVisible().catch(() => false))) await page.getByTestId("bot-name-button").click();
  await page.getByRole("tab", { name: "Computer", exact: true }).click();
  await expect(page.getByTestId("computer-asleep")).toContainText("Computer is asleep");
  await expect(page.getByTestId("computer-wake")).toBeVisible();
  await expect(page.getByTestId("computer-control-pill")).toContainText("Watching");
  await page.getByTestId("computer-asleep").scrollIntoViewIfNeeded();
  await shot(page, "06-asleep-wake");
});
