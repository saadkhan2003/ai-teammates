import { expect, test } from "@playwright/test";

async function setup(page: import("@playwright/test").Page) {
  const list = await (await page.request.get("/api/bots")).json();
  let bot = ((Array.isArray(list) ? list : list.bots) as { id: string; name: string }[])[0];
  if (!bot) {
    const made = await page.request.post("/api/bots", { data: { name: `Teach ${Date.now().toString().slice(-5)}` } });
    expect(made.ok()).toBeTruthy();
    const body = await made.json();
    bot = (body.bot ?? body) as { id: string; name: string };
  }
  const workspace = await (await page.request.get(`/api/bots/${bot.id}/workspace`)).json();
  return { bot, conversationId: workspace.conversationId as string };
}

test("learn-from-demonstration message API: chip metadata, validated recording path, task instruction", async ({ page }) => {
  const { bot, conversationId } = await setup(page);
  const bad = await page.request.post(`/api/conversations/${conversationId}/messages`, { data: { content: "x", skill: "learn-from-demonstration", recording: "/etc/passwd" } });
  expect(bad.status()).toBe(400);
  const badSkill = await page.request.post(`/api/conversations/${conversationId}/messages`, { data: { content: "x", skill: "other", recording: "/workspace/recordings/a.webm" } });
  expect(badSkill.status()).toBe(400);
  const traversal = await page.request.post(`/api/conversations/${conversationId}/messages`, { data: { content: "x", skill: "learn-from-demonstration", recording: "/workspace/recordings/../../etc/a.webm" } });
  expect(traversal.status()).toBe(400);

  const ok = await page.request.post(`/api/conversations/${conversationId}/messages`, { data: { content: "The recording is finished. Learn the task from it.", skill: "learn-from-demonstration", recording: "/workspace/recordings/demo-test.webm" } });
  expect(ok.ok()).toBeTruthy();
  const workspace = await (await page.request.get(`/api/bots/${bot.id}/workspace`)).json();
  const message = (workspace.messages as { content: string; skill?: { label: string }; attachments?: { name: string }[] }[]).find(m => m.skill);
  expect(message?.skill?.label).toBe("Learn from demonstration");
  expect(message?.attachments?.[0]?.name).toBe("demo-test.webm");
  const task = (workspace.tasks as { title: string; instruction?: string }[])[0];
  expect(task).toBeTruthy();

  await page.goto(`/bots/${bot.id}`);
  await expect(page.getByTestId("skill-chip").first()).toHaveText("Learn from demonstration");
  await expect(page.getByTestId("recording-attachment").first()).toContainText("demo-test.webm");
});

test("teach a task: banner with timer and X, red outline on the desktop frame, You're in control pill", async ({ page }) => {
  const { bot } = await setup(page);
  const before = ((await (await page.request.get(`/api/bots/${bot.id}/workspace`)).json()).messages as { skill?: unknown }[]).filter(m => m.skill).length;
  await page.goto(`/bots/${bot.id}`);
  await expect(page.getByTestId("bot-name-button")).toBeVisible();
  if ((await page.getByTestId("bot-name-button").getAttribute("aria-expanded")) !== "true") await page.getByTestId("bot-name-button").click();
  await page.getByRole("tab", { name: "Computer" }).click();
  await page.getByTestId("teach-start").click();
  const banner = page.getByTestId("recording-banner");
  await expect(banner).toContainText(`${bot.name} is watching and learning`, { timeout: 20_000 });
  await expect(page.getByTestId("recording-timer")).toHaveText(/\d\d:\d\d/);
  await expect(page.getByTestId("desktop-frame")).toHaveAttribute("data-recording", "true");
  await expect(page.getByTestId("control-pill")).toHaveAttribute("data-mode", "control");
  await expect(page.getByTestId("control-pill")).toContainText("You're in control");
  await page.getByTestId("recording-cancel").click();
  await expect(banner).toHaveCount(0);
  const workspace = await (await page.request.get(`/api/bots/${bot.id}/workspace`)).json();
  expect(workspace.holder).toBe("agent");
  expect((workspace.messages as { skill?: unknown }[]).filter(m => m.skill).length).toBe(before);
});
