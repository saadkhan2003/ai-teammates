import { expect, test } from "@playwright/test";
import { login } from "./helpers";

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
