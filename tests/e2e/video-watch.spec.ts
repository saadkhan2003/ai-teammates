import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

const BOT = "11111111-1111-4111-8111-111111111111";
const TASK = "22222222-2222-4222-8222-222222222222";
const CONVERSATION = "33333333-3333-4333-8333-333333333333";
const bot = { id: BOT, name: "ATLAS", role: "Chief of staff", section: "Teammates", avatar: "", avatarShape: "blob1", avatarColor: "#ff3045", isPrimary: true, bio: "Runs the day", attention: false };

async function openVideoChat(page: Page, theme: "light" | "dark") {
  await page.addInitScript((value) => localStorage.setItem("teammates-theme", value), theme);
  await page.route("**/api/bots", route => route.fulfill({ json: { bots: [bot] } }));
  await page.route("**/api/system/llm-status", route => route.fulfill({ json: { hasKey: true } }));
  await page.route(`**/api/bots/${BOT}/workspace`, route => route.fulfill({ json: {
    bot, conversationId: CONVERSATION, tasks: [{ id: TASK, title: "Watch attached video", status: "running" }],
    messages: [{ id: "video-answer", role: "assistant", createdAt: "2026-10-25T08:00:00Z",
      content: JSON.stringify({ summary: "A person demonstrates a test scene.", timeline: [{ timestamp: 1, summary: "A test scene is visible." }] }) }],
    messagesHasMore: false, approvals: [], pages: [], holder: "agent", openrouterConnected: true,
  } }));
  await page.route(`**/api/bots/${BOT}/**`, route => route.fulfill({ json: [] }));
  await page.route("**/api/events", route => route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    body: `data: ${JSON.stringify({ type: "video_progress", taskId: TASK, botId: BOT, stage: "Watching part", current: 1, total: 1 })}\n\n`,
  }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/bots/${BOT}`);
  await expect(page.getByTestId("video-progress")).toContainText("Watching part 1/1");
  await expect(page.getByTestId("video-analysis-card")).toContainText("A person demonstrates a test scene.");
}

test("video progress and answer are clear in light and dark chat", async ({ page }) => {
  await login(page);
  await openVideoChat(page, "light");
  await page.screenshot({ path: "/workspace/shots-video-v1/01-chat-video-watch-light.png" });
  await openVideoChat(page, "dark");
  await page.screenshot({ path: "/workspace/shots-video-v1/01-chat-video-watch-dark.png" });
});
