import { expect, test } from "@playwright/test";
import { login } from "./helpers";

const UI_BOT = "11111111-1111-4111-8111-111111111111";
const TASK = "123e4567-e89b-42d3-a456-426614174000";
const bot = { id: UI_BOT, name: "Resume bot", role: "Assistant", section: "Teammates", avatar: "", avatarShape: "blob1", avatarColor: "#ff3045", isPrimary: true, bio: "", attention: false };
const msg = (id: string, content: unknown) => ({ id, role: "assistant", content: JSON.stringify(content), createdAt: new Date().toISOString() });

async function showResumeMessage(page: import("@playwright/test").Page, content: unknown) {
  await login(page);
  await page.route("**/api/bots", route => route.fulfill({ json: { bots: [bot] } }));
  await page.route("**/api/system/llm-status", route => route.fulfill({ json: { hasKey: true } }));
  await page.route(`**/api/bots/${UI_BOT}/**`, route => route.fulfill({ json: [] }));
  await page.route(`**/api/bots/${UI_BOT}/workspace`, route => route.fulfill({ json: { bot, conversationId: UI_BOT, tasks: [], messages: [msg("resume-message", content)], messagesHasMore: false, approvals: [], pages: [], holder: "agent", openrouterConnected: true } }));
  await page.goto(`/bots/${UI_BOT}`);
}

test("cancelled tasks stay stopped when continuation endpoints are called", async ({ page }) => {
  await login(page);
  const botResponse = await page.request.post("/api/bots", { data: { name: `Resume ${Date.now()}` } });
  expect(botResponse.ok()).toBeTruthy();
  const bot = (await botResponse.json()) as { id: string };
  try {
    const workspaceResponse = await page.request.get(`/api/bots/${bot.id}/workspace`);
    expect(workspaceResponse.ok()).toBeTruthy();
    const workspace = (await workspaceResponse.json()) as { conversationId: string };
    const message = await page.request.post(`/api/conversations/${workspace.conversationId}/messages`, { data: { content: "A task that will be cancelled.", asTask: true } });
    expect(message.ok()).toBeTruthy();
    const { taskId } = (await message.json()) as { taskId: string };
    expect((await page.request.post(`/api/tasks/${taskId}/cancel`)).ok()).toBeTruthy();
    expect((await page.request.post(`/api/tasks/${taskId}/continue`, { data: {} })).status()).toBe(409);
    expect((await page.request.post(`/api/tasks/${taskId}/raise-budget`, { data: { maxSteps: 400 } })).status()).toBe(409);
    const tasks = await page.request.get(`/api/bots/${bot.id}/tasks`).then((r) => r.json()) as Array<{ id: string; status: string }>;
    expect(tasks.find((task) => task.id === taskId)?.status).toBe("cancelled");
  } finally {
    await page.request.delete(`/api/bots/${bot.id}`);
  }
});

test("a repeated resumed notice shows its collapsed copy", async ({ page }) => {
  await showResumeMessage(page, { type: "resume", event: "resumed", count: 3, attempt: 4, reason: "lease_expired", stepsUsed: 12, current: "Write the report", firstAt: new Date().toISOString(), lastAt: new Date().toISOString() });
  const notice = page.getByTestId("resume-notice");
  await expect(notice).toHaveAttribute("data-count", "3");
  await expect(notice).toContainText("Resumed 3 times in the last 12 min. Continuing: Write the report");
});

test("an open budget card continues the task", async ({ page }) => {
  await showResumeMessage(page, { type: "resume_card", reason: "budget_reached", state: "open", taskId: TASK, stepsUsed: 50, maxSteps: 50, secondsUsed: 300, maxSeconds: 300, current: "Write the report" });
  let posted = false;
  await page.route(`**/api/tasks/${TASK}/continue`, async route => { posted = route.request().method() === "POST"; await route.fulfill({ json: { ok: true } }); });
  await page.getByTestId("resume-continue").click();
  expect(posted).toBeTruthy();
});

test("a no-progress card has no budget action", async ({ page }) => {
  await showResumeMessage(page, { type: "resume_card", reason: "no_progress", state: "open", taskId: TASK, stepsUsed: 8, maxSteps: 50, secondsUsed: 10, maxSeconds: 300, current: "Check the report" });
  await expect(page.getByTestId("resume-card")).toContainText("I stopped after two attempts with no progress, so I don't loop.");
  await expect(page.getByTestId("resume-continue")).toBeVisible();
  await expect(page.getByTestId("resume-raise")).toHaveCount(0);
});

test("a continued resume card has no actions", async ({ page }) => {
  await showResumeMessage(page, { type: "resume_card", reason: "budget_reached", state: "continued", taskId: TASK, stepsUsed: 50, maxSteps: 250, secondsUsed: 300, maxSeconds: 3900, current: "Write the report" });
  await expect(page.getByTestId("resume-card")).toHaveAttribute("data-state", "continued");
  await expect(page.getByTestId("resume-continue")).toHaveCount(0);
  await expect(page.getByTestId("resume-raise")).toHaveCount(0);
  await expect(page.getByTestId("resume-stop")).toHaveCount(0);
});
