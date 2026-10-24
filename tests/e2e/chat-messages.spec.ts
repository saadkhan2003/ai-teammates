import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const bot = "11111111-1111-4111-8111-111111111111";
const jobId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const pr = "https://example.com/pull/7";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const dir = "/opt/cursor/artifacts/chat-messages";

function shot(page: Page, name: string) {
  mkdirSync(dir, { recursive: true });
  return page.screenshot({ path: `${dir}/${name}.png` });
}

for (const theme of ["light", "dark"] as const) {
  test(`chat message surfaces stay on theme tokens (${theme})`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1280, height: 860 });
    await runTheme(page, theme);
  });
}

async function runTheme(page: Page, theme: "light" | "dark") {
  let releaseMedia = false;
  let releaseUpload = false;
  const jobs = [
    {
      id: jobId,
      title: "Theme fixes",
      status: "merged",
      step: "",
      branch: "cursor/ui-chat-messages",
      prNumber: 7,
      prUrl: pr,
      filesChanged: 8,
      additions: 20,
      deletions: 3,
      updatedAt: "2026-10-24T00:00:00Z",
    },
  ];
  let reactions = [{ id: "bot-like", emoji: "👍", actorType: "bot" }];
  let messages: Record<string, unknown>[] = [
    ...Array.from({ length: 14 }, (_, index) => ({
      id: `pad-${index}`,
      role: index % 2 === 0 ? "assistant" : "user",
      content: `Earlier note ${index} about the handbook revision.`,
      createdAt: "2026-10-23T12:00:00Z",
    })),
    {
      id: "m-user",
      role: "user",
      content: "Please keep the composer white.",
      reactions,
      createdAt: "2026-10-24T01:00:00Z",
    },
    {
      id: "m-bot",
      role: "assistant",
      content: `The fix is on [its live page](${pr}) and the [Library](/bots/${bot}).`,
      replyToId: "m-user",
      createdAt: "2026-10-24T01:01:00Z",
    },
    {
      id: "m-ask",
      role: "assistant",
      content: JSON.stringify({
        type: "question",
        prompt: "Which format should I use?",
        options: ["Standup notes", "Internal FAQ", "Both"],
        styles: ["primary", "primary", "danger"],
        allowCustom: true,
      }),
      createdAt: "2026-10-24T01:02:00Z",
    },
    {
      id: "m-answered",
      role: "assistant",
      content: JSON.stringify({
        type: "question",
        prompt: "Which theme should the card use?",
        options: ["Light", "Dark"],
        answer: ["Dark"],
      }),
      createdAt: "2026-10-24T01:03:00Z",
    },
    { id: "m-file", role: "user", content: "Here is the shot.\n![clip](/shot.png)", createdAt: "2026-10-24T01:04:00Z" },
    { id: "m-skel", role: "assistant", content: "![still](/media/clip.png)", createdAt: "2026-10-24T01:05:00Z" },
    { id: "m-video", role: "user", content: "![reel](/media/clip.mp4)", createdAt: "2026-10-24T01:06:00Z" },
    { id: "m-jobs", role: "assistant", content: '{"type":"coding-jobs"}', createdAt: "2026-10-24T01:07:00Z" },
  ];

  await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => undefined);
  await page.addInitScript((mode) => {
    localStorage.setItem("teammates-theme", mode);
  }, theme);
  await page.emulateMedia({ colorScheme: theme });
  await page.route("**/shot.png", (route) => route.fulfill({ status: 200, contentType: "image/png", body: png }));
  await page.route("**/media/clip.png", async (route) => {
    while (!releaseMedia) await new Promise((resolve) => setTimeout(resolve, 40));
    await route.fulfill({ status: 200, contentType: "image/png", body: png });
  });
  await page.route("**/media/clip.mp4", async (route) => {
    while (!releaseMedia) await new Promise((resolve) => setTimeout(resolve, 40));
    await route.fulfill({ status: 200, contentType: "video/mp4", body: png });
  });
  await page.route("**/api/**", async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    if (url.includes("/api/events")) {
      await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: ": connected\n\n" });
      return;
    }
    if (url.includes("/api/auth/me")) {
      await route.fulfill({ json: { username: "Saad", role: "owner", theme } });
      return;
    }
    if (method === "PUT" && url.includes("/files")) {
      while (!releaseUpload) await new Promise((resolve) => setTimeout(resolve, 40));
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    if (url.includes("/workspace")) {
      await route.fulfill({
        json: {
          bot: { id: bot, name: "Atlas", role: "Chief of staff", avatarColor: "#ff3045" },
          conversationId: bot,
          tasks: [],
          messages,
          approvals: [],
          pages: [],
          holder: "agent",
          openrouterConnected: true,
          codingJobs: jobs,
        },
      });
      return;
    }
    if (url.endsWith("/api/bots") || url.includes("/api/bots?")) {
      await route.fulfill({ json: [{ id: bot, name: "Atlas", role: "Chief of staff", avatarColor: "#ff3045" }] });
      return;
    }
    if (url.includes("/reactions") && method === "POST") {
      const body = route.request().postDataJSON() as { emoji?: string };
      reactions = [{ id: "user-like", emoji: body.emoji ?? "👍", actorType: "user" }, ...reactions.filter((item) => item.actorType !== "user")];
      const target = messages.find((item) => url.includes(String(item.id)));
      if (target) target.reactions = reactions;
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (url.includes("/answer") && method === "POST") {
      const body = route.request().postDataJSON() as { choices?: string[] };
      const ask = messages.find((item) => item.id === "m-ask");
      if (ask) {
        ask.content = JSON.stringify({
          type: "question",
          prompt: "Which format should I use?",
          options: ["Standup notes", "Internal FAQ", "Both"],
          styles: ["primary", "primary", "danger"],
          answer: body.choices ?? [],
        });
      }
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (url.includes("/messages") && method === "POST") {
      const body = route.request().postDataJSON() as { content?: string; replyTo?: string };
      messages = [...messages, { id: `m-sent-${messages.length}`, role: "user", content: body.content ?? "", replyToId: body.replyTo, createdAt: "2026-10-24T02:00:00Z" }];
      await route.fulfill({ json: { ok: true } });
      return;
    }
    await route.fulfill({ json: [] });
  });

  await page.goto(`/bots/${bot}?theme=${theme}`);
  await expect(page.getByTestId("composer")).toBeVisible();
  if (theme === "light") await expect(page.locator("html")).toHaveClass(/light/);
  else await expect(page.locator("html")).not.toHaveClass(/light/);

  const user = page.locator("#message-m-user");
  const botMessage = page.locator("#message-m-bot");
  await user.scrollIntoViewIfNeeded();
  const userBg = await user.getByTestId("message-bubble").evaluate((node) => getComputedStyle(node).backgroundColor);
  const botBg = await botMessage.getByTestId("message-bubble").evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(userBg).toBe("rgb(255, 48, 69)");
  expect(botBg).toBe(theme === "light" ? "rgb(235, 235, 235)" : "rgb(38, 38, 38)");

  await expect(botMessage.getByTestId("message-bubble").getByTestId("reply-quote")).toContainText("Please keep the composer");
  await shot(page, `06-bot-quote-${theme}`);

  await botMessage.getByTestId("link-pill").filter({ hasText: "its live page" }).hover();
  const preview = botMessage.getByTestId("link-pill-wrap").filter({ hasText: "its live page" }).getByTestId("link-preview");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("Theme fixes");
  await expect(preview).toContainText("example.com");
  await expect.poll(async () => botMessage.getByTestId("message-toolbar").evaluate((node) => getComputedStyle(node).opacity)).toBe("1");
  await expect(botMessage.getByTestId("link-pill").filter({ hasText: "its live page" })).toHaveAttribute("target", "_blank");
  await expect(botMessage.getByTestId("link-pill").filter({ hasText: "Library" })).not.toHaveAttribute("target", "_blank");
  await shot(page, `23-link-preview-${theme}`);
  await shot(page, `07-message-toolbar-${theme}`);

  await botMessage.getByTestId("message-react").click();
  const picker = page.getByTestId("reaction-picker");
  await expect(picker).toBeVisible();
  await expect(picker).toContainText("👎");
  const pickerBox = await picker.boundingBox();
  expect(pickerBox && pickerBox.width).toBeLessThan(288);
  await expect(picker).toHaveAttribute("data-side", /above|below/);
  await shot(page, `09-reaction-picker-${theme}`);
  await page.getByTestId("reaction-add").click();
  const full = page.getByTestId("emoji-picker");
  await expect(full).toBeVisible();
  const fullBox = await full.boundingBox();
  expect(fullBox && fullBox.width).toBeLessThan(288);
  await shot(page, `09-emoji-picker-${theme}`);
  await page.keyboard.press("Escape");

  await user.hover();
  await user.getByTestId("message-react").click();
  await page.getByTestId("reaction-picker").getByRole("button", { name: "👍", exact: true }).click();
  await expect(user.locator('[data-testid="reaction-pill"][data-actor="user"]')).toBeVisible();
  await user.locator('[data-testid="reaction-pill"][data-actor="bot"]').hover();
  await expect(page.getByRole("tooltip", { name: "Atlas reacted with 👍" })).toBeVisible();
  await shot(page, `10-reaction-pill-${theme}`);

  const shotCard = page.getByTestId("message-item").filter({ hasText: "Here is the shot." });
  await page.mouse.move(8, 8);
  await shotCard.scrollIntoViewIfNeeded();
  await page.mouse.move(8, 8);
  const toolbar = shotCard.getByTestId("message-toolbar");
  await expect.poll(async () => toolbar.evaluate((node) => getComputedStyle(node).opacity)).toBe("0");
  await shotCard.getByTestId("attachment-card").hover();
  await expect.poll(async () => toolbar.evaluate((node) => getComputedStyle(node).opacity)).toBe("1");
  await expect(shotCard.getByTestId("message-more")).toBeVisible();
  await shot(page, `08-attachment-hover-${theme}`);

  const openCard = page.getByTestId("question-card").filter({ hasText: "Which format should I use?" });
  await openCard.scrollIntoViewIfNeeded();
  await expect(openCard).toHaveAttribute("data-answered", "false");
  await expect(openCard.getByRole("button", { name: "Standup notes", exact: true })).toBeVisible();
  await expect(openCard.locator("[data-letter='C']")).toHaveAttribute("data-style", "danger");
  await shot(page, `11-question-card-${theme}`);
  await openCard.getByText("Which format should I use?").click();
  await page.keyboard.press("b");
  await expect(openCard).toHaveAttribute("data-answered", "true");
  await expect(openCard.getByTestId("option-letter")).toHaveText("B");
  await expect(openCard).toContainText("Internal FAQ");
  await expect(openCard).not.toContainText("Standup notes");
  const letterBg = await openCard.getByTestId("option-letter").evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(letterBg).toBe("rgb(255, 48, 69)");

  const answered = page.getByTestId("question-card").filter({ hasText: "Which theme should the card use?" });
  await answered.scrollIntoViewIfNeeded();
  await expect(answered.getByTestId("option-letter")).toHaveText("B");
  await expect(answered).not.toContainText("Light");
  await shot(page, `12-answered-card-${theme}`);

  const result = page.getByTestId("job-result-card");
  await result.scrollIntoViewIfNeeded();
  await expect(result).toContainText("Theme fixes");
  await expect(result).toContainText("cursor/ui-chat-messages");
  await expect(result).toContainText("PR #7");
  await expect(result).toContainText("8 files changed");
  await expect(result).toContainText("+20");
  await expect(result).toContainText("-3");
  await expect(result.getByTestId("job-result-pr")).toHaveAttribute("href", pr);
  await expect(result.getByTestId("job-result-open")).toBeVisible();
  await shot(page, `22-job-card-${theme}`);

  const skeleton = page.getByTestId("message-item").filter({ hasText: "still" }).getByTestId("media-skeleton");
  await skeleton.scrollIntoViewIfNeeded();
  await expect(skeleton).toBeVisible();
  const videoSkeleton = page.getByTestId("message-item").filter({ has: page.locator("video") }).getByTestId("media-skeleton");
  await expect(videoSkeleton).toBeVisible();
  await shot(page, `19-media-skeleton-${theme}`);
  releaseMedia = true;
  await expect(page.locator("img[alt='still']")).toBeVisible();
  await expect(page.getByTestId("message-item").filter({ hasText: "still" }).getByTestId("media-skeleton")).toHaveCount(0);
  await shot(page, `19-media-ready-${theme}`);

  await page.locator('input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await expect(page.getByTestId("upload-bar")).toBeVisible();
  await shot(page, `19-upload-bar-${theme}`);
  releaseUpload = true;
  await expect(page.getByTestId("upload-card")).toHaveAttribute("data-status", "done");

  const scroller = page.getByTestId("chat-scroll");
  await scroller.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect(page.getByTestId("jump-to-latest")).toHaveCount(0);
  await user.hover();
  await user.getByTestId("message-reply").click();
  await expect(page.getByTestId("reply-chip")).toContainText("Please keep the composer white.");
  await shot(page, `06-reply-chip-${theme}`);
  await page.getByTestId("composer").fill("Noted");
  await page.getByTestId("send-chat").click();
  const sent = page.getByTestId("message-item").filter({ hasText: "Noted" });
  await expect(sent.getByTestId("reply-quote")).toBeVisible();
  await expect(sent.getByTestId("message-bubble").getByTestId("reply-quote")).toHaveCount(0);
  const quoteBox = await sent.getByTestId("reply-quote").boundingBox();
  const bubbleBox = await sent.getByTestId("message-bubble").boundingBox();
  expect(quoteBox && bubbleBox && quoteBox.y + quoteBox.height <= bubbleBox.y + 2).toBeTruthy();
  await sent.getByTestId("reply-quote").click();
  await expect(page.locator("#message-m-user")).toHaveAttribute("data-highlight", "true");
  await shot(page, `06-reply-highlight-${theme}`);

  await scroller.evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(page.getByTestId("jump-to-latest")).toBeVisible();
  await shot(page, `18-jump-button-${theme}`);
  await page.getByTestId("composer").fill("One more");
  await page.getByTestId("send-chat").click();
  const pill = page.getByTestId("new-messages");
  await expect(pill).toContainText("↓ 1 new message");
  const pillBg = await pill.evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(pillBg).toBe("rgb(255, 48, 69)");
  await shot(page, `18-new-messages-${theme}`);
  await pill.getByRole("button", { name: "Dismiss new messages" }).click();
  await expect(page.getByTestId("jump-to-latest")).toBeVisible();
  await page.getByTestId("jump-to-latest").click();
  await expect(page.getByTestId("jump-to-latest")).toHaveCount(0);

  const last = page.getByTestId("message-item").last();
  await last.scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    const items = document.querySelectorAll("[data-testid='message-item']");
    const anchor = items[items.length - 1]?.querySelector("[data-testid='message-react']");
    const scroller = document.querySelector("[data-testid='chat-scroll']");
    if (!(anchor instanceof HTMLElement) || !(scroller instanceof HTMLElement)) return;
    const rect = anchor.getBoundingClientRect();
    const bounds = scroller.getBoundingClientRect();
    scroller.scrollTop += rect.bottom - (bounds.bottom - 6);
  });
  await last.hover();
  await last.getByTestId("message-react").click();
  const flipped = page.getByTestId("reaction-picker");
  await expect(flipped).toBeVisible();
  await expect(flipped).toHaveAttribute("data-side", "above");
  await shot(page, `09-reaction-picker-above-${theme}`);
}
