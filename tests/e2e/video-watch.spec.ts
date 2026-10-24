import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { login } from "./helpers";

const BOT = "11111111-1111-4111-8111-111111111111";
const TASK = "22222222-2222-4222-8222-222222222222";
const CONVERSATION = "33333333-3333-4333-8333-333333333333";
const VIDEO_QUESTION = "What happens in the attached video?";
const attachment = "[attached: /workspace/uploads/video-watch.mp4]";
const bot = { id: BOT, name: "ATLAS", role: "Chief of staff", section: "Teammates", avatar: "", avatarShape: "blob1", avatarColor: "#ff3045", isPrimary: true, bio: "Runs the day", attention: false };

function sendIdleDesktopFrame(socket: import("@playwright/test").WebSocketRoute) {
  const bytes = (...values: number[]) => new Uint8Array(values);
  let stage = 0;
  socket.send("RFB 003.008\n");
  socket.onMessage((message) => {
    if (typeof message === "string") {
      socket.send(bytes(1, 1) as never); // One security type: no authentication.
      return;
    }
    if (stage === 0) {
      stage = 1;
      socket.send(bytes(0, 0, 0, 0) as never); // SecurityResult: success.
      return;
    }
    if (stage === 1) {
      stage = 2;
      const name = new TextEncoder().encode("Idle desktop");
      const serverInit = new Uint8Array(24 + name.length);
      const view = new DataView(serverInit.buffer);
      view.setUint16(0, 320);
      view.setUint16(2, 200);
      serverInit.set([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0], 4);
      view.setUint32(20, name.length);
      serverInit.set(name, 24);
      socket.send(serverInit as never);
      return;
    }

    // A simple neutral desktop frame: muted gray-blue background with a subtle
    // darker band. This keeps the computer panel representative without a live stack.
    const width = 320;
    const height = 200;
    const update = new Uint8Array(4 + 12 + width * height * 4);
    const view = new DataView(update.buffer);
    update[0] = 0; // FramebufferUpdate
    view.setUint16(2, 1);
    view.setUint16(8, width);
    view.setUint16(10, height);
    view.setUint32(12, 0); // Raw encoding
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = 16 + (y * width + x) * 4;
        const band = y > 145 && y < 154;
        update[offset] = band ? 99 : 143;
        update[offset + 1] = band ? 87 : 116;
        update[offset + 2] = band ? 76 : 104;
      }
    }
    socket.send(update as never);
  });
}

async function openVideoChat(page: Page, theme: "light" | "dark") {
  await page.addInitScript((value) => localStorage.setItem("teammates-theme", value), theme);
  await page.route("**/api/bots", route => route.fulfill({ json: { bots: [bot] } }));
  await page.route("**/api/system/llm-status", route => route.fulfill({ json: { hasKey: true } }));
  await page.route(`**/api/computers/${BOT}/**`, route => route.fulfill({ json: { state: "running", online: true, healthy: true, holder: null } }));
  await page.route(`**/api/computers/${BOT}/vnc-ticket**`, route => route.fulfill({ json: {
    token: "e2e-idle-desktop", mode: "view", epoch: 1,
    state: "running", online: true, screen: { width: 320, height: 200, placeholder: true },
  } }));
  page.routeWebSocket("**/vnc/websockify**", socket => sendIdleDesktopFrame(socket));

  const messages: Array<Record<string, unknown>> = [];
  let messageNo = 0;
  await page.route(`**/api/conversations/${CONVERSATION}/messages`, async route => {
    const body = route.request().postDataJSON() as { content?: string };
    const content = body.content ?? "";
    const at = (minute: number) => `2026-10-25T08:${String(minute).padStart(2, "0")}:00Z`;
    messages.push({ id: `user-${++messageNo}`, role: "user", createdAt: at(messageNo * 2), content });
    if (messageNo === 1) {
      messages.push({ id: "video-analysis", role: "assistant", createdAt: at(3), content: JSON.stringify({ summary: "A person demonstrates a test scene.", timeline: [{ timestamp: 1, summary: "A test scene is visible." }] }) });
      messages.push({ id: "video-answer", role: "assistant", createdAt: at(4), content: "The video shows a person demonstrating a test scene." });
    } else {
      messages.push({ id: "video-followup", role: "assistant", createdAt: at(6), content: "It ends with the test scene." });
    }
    await route.fulfill({ json: { ok: true } });
  });
  await page.route(`**/api/bots/${BOT}/**`, route => route.fulfill({ json: [] }));
  await page.route(`**/api/bots/${BOT}/workspace`, route => route.fulfill({ json: {
    bot, conversationId: CONVERSATION, tasks: [{ id: TASK, title: "Watch attached video", status: messageNo ? "completed" : "running" }],
    messages, messagesHasMore: false, approvals: [], pages: [], holder: "agent", openrouterConnected: true,
  } }));
  await page.route("**/api/events", route => route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    body: messageNo
      ? `data: ${JSON.stringify({ type: "task", taskId: TASK, botId: BOT, status: "completed" })}\n\n`
      : `data: ${JSON.stringify({ type: "video_progress", taskId: TASK, botId: BOT, detail: { stage: "Watching part", current: 1, total: 1 } })}\n\n`,
  }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/bots/${BOT}`);
  await expect(page.getByTestId("video-progress")).toContainText("Watching part 1/1");
  await expect(page.getByTestId("computer-state")).toHaveCount(0);
  await expect(page.getByText("Couldn't connect")).toHaveCount(0);
  await expect(page.getByText("The computer isn't answering")).toHaveCount(0);
  await expect(page.getByText("The desktop session did not include a token.")).toHaveCount(0);
  await expect(page.getByText(/Raw channel missing property:/)).toHaveCount(0);
}

async function sendVideoQuestion(page: Page) {
  await page.getByTestId("composer-file").setInputFiles(path.join(__dirname, "fixtures", "video-watch.mp4"));
  await expect(page.getByTestId("composer")).toHaveValue(attachment);
  await page.getByTestId("composer").fill(`${attachment}\n${VIDEO_QUESTION}`);
  await page.getByTestId("send-chat").click();
}

async function captureAnswerState(page: Page, theme: "light" | "dark") {
  await expect(page.getByTestId("recording-attachment")).toContainText("video-watch.mp4");
  await expect(page.locator("body")).not.toContainText("/workspace/uploads");
  await expect(page.getByTestId("video-analysis-card")).toContainText("A person demonstrates a test scene.");
  await expect(page.getByText("The video shows a person demonstrating a test scene.")).toBeVisible();
  await expect(page.getByText("Couldn't connect")).toHaveCount(0);
  await expect(page.getByText("The computer isn't answering")).toHaveCount(0);
  const rows = page.getByTestId("message-item");
  const contents = await rows.allTextContents();
  const userIndex = contents.findIndex(text => text.includes(VIDEO_QUESTION));
  const analysisIndex = contents.findIndex(text => text.includes("Video analysis"));
  const answerIndex = contents.findIndex(text => text.includes("The video shows a person demonstrating a test scene."));
  expect(userIndex).toBeGreaterThanOrEqual(0);
  expect(analysisIndex).toBeGreaterThan(userIndex);
  expect(answerIndex).toBeGreaterThan(analysisIndex);
  await page.screenshot({ path: `/workspace/shots-video-v1/02-answer-${theme}.png` });
}

for (const theme of ["light", "dark"] as const) {
  test(`video progress, answer, and follow-up in ${theme} theme`, async ({ page }) => {
    await login(page);
    await openVideoChat(page, theme);
    await page.screenshot({ path: `/workspace/shots-video-v1/01-progress-${theme}.png` });
    await sendVideoQuestion(page);
    await expect(page.getByTestId("message-item").filter({ hasText: VIDEO_QUESTION })).toBeVisible();
    await captureAnswerState(page, theme);

    await page.getByTestId("composer").fill("What happens at the end?");
    await page.getByTestId("send-chat").click();
    await expect(page.getByText("It ends with the test scene.")).toBeVisible();
    await expect(page.getByTestId("video-progress")).toHaveCount(0);
    await expect(page.getByTestId("stop-run")).toHaveCount(0);
    await page.screenshot({ path: `/workspace/shots-video-v1/03-followup-${theme}.png` });
  });
}

test("staff can view video settings and members cannot", async ({ page }) => {
  await login(page);
  await page.addInitScript(() => localStorage.setItem("teammates-theme", "light"));
  await page.route("**/api/auth/me", route => route.fulfill({ json: { role: "owner" } }));
  await page.route("**/api/admin/config/video", route => route.fulfill({ json: { visionModel: "vision-test", transcriptionModel: "transcription-test", transcriptionProvider: "DeepInfra", allowFallbacks: false } }));
  await page.goto("/settings/admin-config/video");
  await expect(page.getByLabel("Video vision model")).toHaveValue("vision-test");
  await expect(page.getByLabel("Transcription model")).toHaveValue("transcription-test");
  await expect(page.getByLabel("Transcription provider pin")).toHaveCount(0);
  await expect(page.getByText("Transcription uses a single fixed service with no fallback.")).toBeVisible();
  await expect(page.getByText("DeepInfra")).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(async () => Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => undefined))));
  await page.screenshot({ path: "/workspace/shots-video-v1/04-admin-video-settings-light.png" });

  await page.addInitScript(() => localStorage.setItem("teammates-theme", "dark"));
  await page.reload();
  await expect(page.getByLabel("Video vision model")).toHaveValue("vision-test");
  await page.evaluate(async () => Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => undefined))));
  await page.screenshot({ path: "/workspace/shots-video-v1/04-admin-video-settings-dark.png" });

  await page.route("**/api/auth/me", route => route.fulfill({ json: { role: "member" } }));
  await page.reload();
  await expect(page.getByText("Admin access required")).toBeVisible();
  await expect(page.getByLabel("Video vision model")).toHaveCount(0);
});
