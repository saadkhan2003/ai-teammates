import fs from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";

const owner = process.env.OWNER_USERNAME ?? "saad";
const password = process.env.OWNER_PASSWORD ?? "teammates-dev";
const BOT_NAME = "Question card";
const ASK = "Ask which Rakazo ideas should go in now";
const PROMPT = "Which Rakazo ideas should go in now?";
const CHOICE = "Keep all for v0.3";
const REMEMBER = "Remember that my favorite editor is Helix";
const FORGET = "Forget that my favorite editor is Helix";

type TaskRow = {
  id: string;
  instruction?: string;
  status: string;
  result?: string;
  error?: string;
};

const createdBotIds: string[] = [];

function resultText(task: TaskRow): string {
  const raw = task.result ?? "";
  try {
    const parsed = JSON.parse(raw) as { text?: string };
    return String(parsed.text ?? raw);
  } catch {
    return String(raw);
  }
}

async function shot(target: Page | Locator, name: string) {
  const artifactDir = "/opt/cursor/artifacts/screenshots/visual";
  const repoDir = "/workspace/docs/evidence/visual";
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.mkdirSync(repoDir, { recursive: true });
  const artifact = `${artifactDir}/${name}.png`;
  const repo = `${repoDir}/${name}.png`;
  await target.screenshot({ path: artifact });
  fs.copyFileSync(artifact, repo);
}

async function login(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("teammates-theme", "light");
  });
  await page.goto("/login");
  await page.getByTestId("login-username").fill(owner);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("app-shell")).toBeVisible();
}

async function deleteNamed(page: Page, name: string) {
  const response = await page.request.get("/api/bots");
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  const bots = (Array.isArray(body) ? body : []) as { id?: string; name?: string }[];
  for (const bot of bots) {
    if (!bot.id || bot.name !== name) continue;
    const removed = await page.request.delete(`/api/bots/${bot.id}`);
    expect(removed.ok() || removed.status() === 404, `delete leftover ${name}`).toBeTruthy();
  }
}

async function createBot(page: Page): Promise<string> {
  const response = await page.request.post("/api/bots", { data: { name: BOT_NAME, role: "clerk", instructions: "" } });
  const body = (await response.json()) as { id?: string; error?: string; reason?: string };
  expect(response.ok(), `create bot ${response.status()} ${JSON.stringify(body)}`).toBeTruthy();
  expect(body.id).toBeTruthy();
  createdBotIds.push(body.id!);
  return body.id!;
}

async function listTasks(page: Page, botId: string): Promise<TaskRow[]> {
  const response = await page.request.get(`/api/bots/${botId}/tasks`);
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  return Array.isArray(body) ? body : [];
}

async function waitInstruction(page: Page, botId: string, instruction: string, timeout = 120_000): Promise<TaskRow> {
  const start = Date.now();
  let last: TaskRow | undefined;
  while (Date.now() - start < timeout) {
    last = (await listTasks(page, botId)).find((row) => (row.instruction ?? "").startsWith(instruction));
    if (last && ["completed", "failed", "cancelled"].includes(last.status)) return last;
    await page.waitForTimeout(500);
  }
  throw new Error(`timeout ${instruction} status=${last?.status ?? "missing"} result=${last ? resultText(last) : ""}`);
}

test.afterEach(async ({ page }) => {
  const ids = createdBotIds.splice(0);
  for (const id of ids) {
    const removed = await page.request.delete(`/api/bots/${id}`);
    expect(removed.ok() || removed.status() === 404, `delete ${id} ${removed.status()}`).toBeTruthy();
  }
});

test("question card answer survives reload and memory notices render", async ({ page }, testInfo) => {
  const prefix = testInfo.project.name === "desktop" ? "light-desktop" : "light-390";
  await login(page);
  await deleteNamed(page, BOT_NAME);
  const botId = await createBot(page);
  await page.goto(`/bots/${botId}`);
  await expect(page.getByTestId("composer")).toBeVisible();

  await page.getByTestId("composer").fill(ASK);
  await page.getByTestId("assign-task").click();
  const card = page.getByTestId("question-card");
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card).toHaveAttribute("data-answered", "false");
  await expect(card).toContainText(PROMPT);
  const choice = card.getByRole("button", { name: CHOICE, exact: true });
  const danger = card.getByRole("button", { name: "Drop them", exact: true });
  await expect(choice).toBeVisible();
  await expect(danger).toHaveAttribute("data-style", "danger");
  await expect(card.getByTestId("question-custom")).toBeVisible();
  const box = await card.boundingBox();
  const viewport = page.viewportSize();
  expect(box && viewport && box.x >= 0 && box.x + box.width <= viewport.width + 1).toBeTruthy();
  await shot(card, `${prefix}-question-card-open`);

  await choice.click();
  const answered = page.getByTestId("question-answered");
  await expect(answered).toBeVisible();
  await expect(answered).toContainText(PROMPT);
  await expect(answered).toContainText(CHOICE);
  await expect(answered.locator("span").first()).toHaveText(owner.trim().charAt(0).toUpperCase());
  await expect(page.getByTestId("question-card")).toHaveAttribute("data-answered", "true");
  await expect(page.getByRole("button", { name: CHOICE, exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Drop them", exact: true })).toHaveCount(0);
  await shot(page.getByTestId("question-card"), `${prefix}-question-card-answered`);

  await page.reload();
  await expect(page.getByTestId("question-answered")).toContainText(PROMPT);
  await expect(page.getByTestId("question-answered")).toContainText(CHOICE);
  await expect(page.getByTestId("question-card")).toHaveAttribute("data-answered", "true");
  await expect(page.getByRole("button", { name: CHOICE, exact: true })).toHaveCount(0);

  const task = await waitInstruction(page, botId, ASK);
  expect(task.status, resultText(task)).toBe("completed");
  expect(resultText(task)).toContain(CHOICE);
  await expect(page.getByText(`You chose ${CHOICE}`)).toBeVisible({ timeout: 20_000 });

  await page.getByTestId("composer").fill(REMEMBER);
  await page.getByTestId("assign-task").click();
  const saved = page.locator('[data-testid="memory-notice"][data-action="saved"]');
  await expect(saved).toBeVisible({ timeout: 60_000 });
  await expect(saved).toContainText("Saved to notes");
  await saved.click();
  await expect(page.getByTestId("memory-fact")).toContainText("My favorite editor is Helix");
  const savedRow = page.locator('[data-testid="message-item"]').filter({ has: saved });
  await shot(savedRow, `${prefix}-memory-notice`);
  const remembered = await waitInstruction(page, botId, REMEMBER);
  expect(remembered.status, resultText(remembered)).toBe("completed");

  await page.getByTestId("composer").fill(FORGET);
  await page.getByTestId("assign-task").click();
  const forgot = page.locator('[data-testid="memory-notice"][data-action="forgot"]');
  await expect(forgot).toBeVisible({ timeout: 60_000 });
  await expect(forgot).toContainText("Forgot a note");
  await forgot.click();
  await expect(page.getByTestId("memory-fact").last()).toContainText("My favorite editor is Helix");
  const forgotten = await waitInstruction(page, botId, FORGET);
  expect(forgotten.status, resultText(forgotten)).toBe("completed");
  expect(resultText(forgotten)).toContain("Forgot.");
});
