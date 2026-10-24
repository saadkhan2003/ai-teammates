import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { login } from "./helpers";

const BOT = "11111111-1111-4111-8111-111111111111";
const TASK = "22222222-2222-4222-8222-222222222222";
const CONVERSATION = "33333333-3333-4333-8333-333333333333";
const bot = { id: BOT, name: "ATLAS", role: "Chief of staff", section: "Teammates", avatar: "", avatarShape: "blob1", avatarColor: "#ff3045", isPrimary: true, bio: "Runs the day", attention: false };

async function openVideoChat(page: Page, theme: "light" | "dark") {
  await page.addInitScript((value) => localStorage.setItem("teammates-theme", value), theme);
  await page.route("**/api/bots", route => route.fulfill({ json: { bots: [bot] } }));
  await page.route("**/api/system/llm-status", route => route.fulfill({ json: { hasKey: true } }));
  const messages: Array<Record<string, unknown>> = [{ id: "video-answer", role: "assistant", createdAt: "2026-10-25T08:00:00Z",
    content: JSON.stringify({ summary: "A person demonstrates a test scene.", timeline: [{ timestamp: 1, summary: "A test scene is visible." }] }) }];
  await page.route(`**/api/conversations/${CONVERSATION}/messages`, async route => {
    const body = route.request().postDataJSON() as { content?: string };
    const content = body.content ?? "";
    messages.push({ id: `user-${messages.length}`, role: "user", createdAt: "2026-10-25T08:01:00Z", content });
    if (messages.filter(message => message.role === "user").length > 1)
      messages.push({ id: `followup-${messages.length}`, role: "assistant", createdAt: "2026-10-25T08:02:00Z", content: "It ends with the test scene." });
    await route.fulfill({ json: { ok: true } });
  });
  await page.route(`**/api/bots/${BOT}/**`, route => route.fulfill({ json: [] }));
  await page.route(`**/api/computers/${BOT}/**`, route => route.fulfill({ json: { state: "ready", holder: "agent" } }));
  await page.route(`**/api/bots/${BOT}/workspace`, route => route.fulfill({ json: {
    bot, conversationId: CONVERSATION, tasks: [{ id: TASK, title: "Watch attached video", status: "running" }],
    messages,
    messagesHasMore: false, approvals: [], pages: [], holder: "agent", openrouterConnected: true,
  } }));
  await page.route("**/api/events", route => route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    body: `data: ${JSON.stringify({ type: "video_progress", taskId: TASK, botId: BOT, detail: { stage: "Watching part", current: 1, total: 1 } })}\n\n`,
  }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/bots/${BOT}`);
  await expect(page.getByTestId("video-progress")).toContainText("Watching part 1/1");
  await expect(page.getByTestId("video-analysis-card")).toContainText("A person demonstrates a test scene.");
}

test("video progress and answer are clear in light and dark chat", async ({ page }) => {
  await login(page);
  await openVideoChat(page, "light");
  await page.getByTestId("composer-file").setInputFiles(path.join(__dirname, "fixtures", "video-watch.mp4"));
  const attachment = "[attached: /workspace/uploads/video-watch.mp4]";
  await expect(page.getByTestId("composer")).toHaveValue(attachment);
  await page.getByTestId("composer").fill(`${attachment}\nWhat happens in the attached video?`);
  await page.getByTestId("send-chat").click();
  await expect(page.getByTestId("video-progress")).toContainText("Watching part 1/1");
  await expect(page.getByTestId("video-analysis-card")).toContainText("A person demonstrates a test scene.");
  await page.screenshot({ path: "/workspace/shots-video-v1/01-chat-video-watch-light.png" });
  await page.getByTestId("composer").fill("What happens at the end?");
  await page.getByTestId("send-chat").click();
  await expect(page.getByText("It ends with the test scene.")).toBeVisible();
  await openVideoChat(page, "dark");
  await page.getByTestId("composer-file").setInputFiles(path.join(__dirname, "fixtures", "video-watch.mp4"));
  await page.getByTestId("composer").fill(`${attachment}\nWhat happens in the attached video?`);
  await page.getByTestId("send-chat").click();
  await expect(page.getByTestId("video-progress")).toContainText("Watching part 1/1");
  await expect(page.getByTestId("video-analysis-card")).toContainText("A person demonstrates a test scene.");
  await page.screenshot({ path: "/workspace/shots-video-v1/01-chat-video-watch-dark.png" });
  await page.getByTestId("composer").fill("What happens at the end?");
  await page.getByTestId("send-chat").click();
  await expect(page.getByText("It ends with the test scene.")).toBeVisible();
});
