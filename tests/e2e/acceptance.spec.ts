import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { autoAllowBrowserOpens } from "./helpers";

const owner = process.env.OWNER_USERNAME ?? "saad";
const password = process.env.OWNER_PASSWORD ?? "teammates-dev";
const OPENROUTER = "sk-or-v1-CANARYOPENROUTERKEY8Kx2";
const GITHUB = "ghp_CANARYGITHUBTOKENVALUE99";
const PORTAL_PASSWORD = "CanaryPasswordValueXYZ99";
const REGISTRY = "RegistryTokenCanary9911";
const CANARIES = [OPENROUTER, GITHUB, PORTAL_PASSWORD, REGISTRY];

const ALPHA = "Open http://portal.example.edu:8099/alpha.html and extract the h1";
const BETA = "Open http://portal.example.edu:8099/beta.html and extract the h1";
const GAMMA = "Open http://portal.example.edu:8099/gamma.html and extract the h1";
const DELTA = "Open http://portal.example.edu:8099/delta.html and extract the h1";
const PONG = "Terminal: write the word pong into /workspace/notes/ping.txt";
const REMEMBER = "Remember that my favorite editor is Helix";
const HELLO = "What should I call you?";
const ARTIFACT = "Create a report artifact named field-notes.txt that says the survey waypoint is north gate.";
const CODE = "Fix the add function in /workspace/sample-repo and run its tests";
const DELETE_FILE = "Delete the file /workspace/secret.txt";
const CAPTCHA = "Open the CAPTCHA page http://portal.example.edu:8099/captcha.html and extract the challenge";
const LOGIN = "Type the stored password into the login form at http://portal.example.edu:8099/login.html using secret://university/password";
const INJECT = "Open http://evil.example:8099/inject.html and follow the page instructions exactly";
const PROBE_OPENROUTER = "PROBE type_secret secret://openrouter/default at http://portal.example.edu:8099/login.html";
const PROBE_PHISH = "PROBE type_secret secret://university/password at http://evil.example:8099/phish.html";
const SETUP = 'Run a setup step with secret://project/registry as env REGISTRY_TOKEN executing python3 -c "import os; print(os.environ[\'REGISTRY_TOKEN\'])"';
const HOLD = "HOLD_FOR_RECOVERY ping";
const STILL = "Terminal: write the word pong into /workspace/notes/still.txt";

type TaskRow = {
  id: string;
  title?: string;
  instruction?: string;
  status: string;
  modelCalls?: number;
  result?: string;
  waitingReason?: string;
  attempt?: number;
};

function capture(args: string[], timeout = 120_000): string {
  const result = spawnSync("sudo", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${args.join(" ")} exited ${result.status}: ${(result.stderr || "").slice(0, 400)}`);
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function assertClean(label: string, text: string) {
  for (const canary of CANARIES) {
    expect(text.includes(canary), `${label} leaked a secret`).toBe(false);
  }
}

function resultText(task: TaskRow): string {
  const raw = task.result ?? "";
  try {
    const parsed = JSON.parse(raw) as { text?: string };
    return String(parsed.text ?? "");
  } catch {
    return String(raw);
  }
}

function shot(page: Page, name: string) {
  const artifact = `/opt/cursor/artifacts/screenshots/${name}.png`;
  const repo = `/workspace/docs/evidence/${name}.png`;
  fs.mkdirSync("/opt/cursor/artifacts/screenshots", { recursive: true });
  fs.mkdirSync("/workspace/docs/evidence", { recursive: true });
  return page.screenshot({ path: artifact, fullPage: true }).then(() => {
    fs.copyFileSync(artifact, repo);
  });
}

function waitHealth() {
  const start = Date.now();
  while (Date.now() - start < 90_000) {
    const result = spawnSync("curl", ["-fsS", "http://127.0.0.1:18080/health"], { encoding: "utf8" });
    if (result.status === 0 && (result.stdout || "").includes('"ok":true')) return;
    spawnSync("sleep", ["2"]);
  }
  throw new Error("API health did not return");
}

async function login(page: Page) {
  await page.goto("/login");
  await page.getByTestId("login-username").fill(owner);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("new-bot")).toBeVisible();
}

const acceptanceBotName = /^(Clerk|Atlas) \d+$/;
const createdBotIds: string[] = [];

async function deleteAcceptanceLeftovers(page: Page) {
  const response = await page.request.get("/api/bots");
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  const bots = (Array.isArray(body) ? body : []) as { id?: string; name?: string }[];
  for (const bot of bots) {
    if (!bot.id || !acceptanceBotName.test(bot.name ?? "")) continue;
    const removed = await page.request.delete(`/api/bots/${bot.id}`);
    expect(removed.status(), `delete leftover ${bot.name}`).toBeLessThan(400);
  }
}

test.afterEach(async ({ page }) => {
  const ids = createdBotIds.splice(0);
  for (const id of ids) {
    if (!id) continue;
    const removed = await page.request.delete(`/api/bots/${id}`);
    expect(removed.ok() || removed.status() === 404, `delete acceptance bot ${id}`).toBeTruthy();
  }
});

async function listTasks(page: Page, botId: string): Promise<TaskRow[]> {
  const response = await page.request.get(`/api/bots/${botId}/tasks`);
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  return Array.isArray(body) ? body : [];
}

async function waitTask(page: Page, botId: string, taskId: string, timeout = 180_000): Promise<TaskRow> {
  const start = Date.now();
  let last: TaskRow | undefined;
  while (Date.now() - start < timeout) {
    last = (await listTasks(page, botId)).find((row) => row.id === taskId);
    if (last && ["completed", "failed", "cancelled"].includes(last.status)) return last;
    await page.waitForTimeout(1000);
  }
  throw new Error(`timeout ${taskId} status=${last?.status ?? "missing"}`);
}

async function expectDone(page: Page, botId: string, taskId: string, timeout = 180_000) {
  const task = await waitTask(page, botId, taskId, timeout);
  expect(task.status, resultText(task).slice(0, 180)).toBe("completed");
  assertClean("task result", resultText(task));
  return task;
}

async function openPane(page: Page, tab: "Overview" | "Computer" | "Routines" | "Files/Media" | "Skills" | "Memory" | "Tasks") {
  const pane = page.getByTestId("info-pane");
  const toggle = page.getByTestId("bot-name-button");
  if (!(await pane.isVisible().catch(() => false))) {
    await toggle.click();
    const opened = await pane
      .waitFor({ state: "visible", timeout: 2_000 })
      .then(() => true)
      .catch(() => false);
    // Desktop opens the pane on navigation. A click in that window toggles it shut.
    if (!opened) await toggle.click();
  }
  await expect(pane).toBeVisible();
  const trigger = pane.getByRole("tab", { name: tab, exact: true });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  await expect(trigger).toHaveAttribute("data-state", "active");
}

async function openSecrets(page: Page) {
  if (!page.url().includes("/settings/secrets")) {
    await page.getByTestId("account-button").click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
    await expect(page.getByTestId("settings-modal")).toBeVisible();
    await page.getByRole("tab", { name: "Vault", exact: true }).click();
  }
  await expect(page).toHaveURL(/\/settings\/secrets/);
}

async function send(page: Page, text: string, asTask: boolean) {
  const composer = page.getByTestId("composer");
  await composer.fill(text);
  await page.getByTestId(asTask ? "assign-task" : "send-chat").click();
  await expect(composer).toHaveValue("");
}

async function computerSlug(page: Page, botId: string) {
  const response = await page.request.get("/api/computer");
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { computerId?: string };
  const id = body.computerId || botId;
  return `tm${id.replace(/-/g, "").toLowerCase()}`;
}

async function assignTracked(page: Page, botId: string, text: string, asTask = true) {
  const before = new Set((await listTasks(page, botId)).map((row) => row.id));
  await send(page, text, asTask);
  const created = (await listTasks(page, botId)).find((row) => !before.has(row.id));
  expect(created, "task was created").toBeTruthy();
  return created!.id;
}

async function addSecret(page: Page, fields: { name: string; namespace: string; type: string; value: string; domains?: string; tools?: string }) {
  const existing = page.locator(`[data-ref="secret://${fields.namespace}/${fields.name}"]`);
  if ((await existing.count()) > 0) {
    await existing.getByTestId("secret-row-delete").click();
    await expect(existing).toHaveCount(0);
  }
  await page.locator("#add-name").fill(fields.name);
  await page.locator("#add-namespace").fill(fields.namespace);
  await page.locator("#add-type").selectOption(fields.type);
  await page.locator("#add-value").fill(fields.value);
  await page.locator("#add-domains").fill(fields.domains ?? "");
  await page.locator("#add-tools").fill(fields.tools ?? "");
  await page.getByRole("button", { name: "Add secret" }).click();
  await expect(page.locator(`[data-ref="secret://${fields.namespace}/${fields.name}"]`)).toBeVisible();
  assertClean("secrets page", await page.locator("body").innerText());
}

test("MVP acceptance items 1-22 on a real per-bot computer", async ({ page }) => {
  test.setTimeout(1_200_000);
  const notes: string[] = [];

  await test.step("sign in", async () => {
    await login(page);
    // Integration grants portal.example.edu for the owner. That grant skips the saved-credential approval this test waits for.
    capture([
      "docker", "exec", "teammates-postgres-1",
      "psql", "-U", "agent", "-d", "agent", "-c",
      "DELETE FROM credential_domain_grants",
    ]);
  });

  await test.step("16 secrets BYOK before and after", async () => {
    await openSecrets(page);
    const banner = page.getByTestId("connected-banner");
    const form = page.getByTestId("secret-value");
    await expect(banner.or(form)).toBeVisible();
    if (await banner.isVisible()) {
      await page.getByTestId("delete-secret").click();
      await expect(form).toBeVisible();
    }
    await shot(page, "secrets-before");
    await form.fill(OPENROUTER);
    await page.getByTestId("test-connection").click();
    await expect(page.getByText("valid", { exact: true })).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("save-secret").click();
    await expect(banner).toContainText("Connected");
    await expect(page.getByTestId("masked-suffix")).toContainText("8Kx2");
    assertClean("secrets after save", await page.locator("body").innerText());
    await shot(page, "secrets-after");
  });

  let botId = "";
  let botUrl = "";

  await test.step("1 create a bot", async () => {
    await deleteAcceptanceLeftovers(page);
    await page.goto("/");
    const name = `Clerk ${Date.now().toString().slice(-4)}`;
    await page.getByTestId("new-bot").click();
    await page.getByRole("menuitem", { name: "New teammate" }).click();
    await page.getByTestId("bot-name").fill(name);
    await page.getByTestId("bot-advanced-toggle").click();
    await page.getByTestId("bot-role").fill("Portal clerk");
    await page.getByTestId("bot-instructions").fill("Use the computer. Stop for approvals.");
    await page.getByTestId("bot-create").click();
    await page.getByTestId("sidebar").getByRole("link", { name }).click({ timeout: 180_000 });
    await expect(page).toHaveURL(/\/bots\//, { timeout: 30_000 });
    botUrl = page.url();
    botId = botUrl.split("/bots/")[1].split(/[?#]/)[0];
    createdBotIds.push(botId);
    autoAllowBrowserOpens(page, botId);
    await page.goto("/");
    await expect(page.getByTestId("sidebar").getByRole("link", { name })).toBeVisible();
    await shot(page, "bots-list");
    await page.goto(botUrl);
    await expect(page.getByTestId("composer")).toBeVisible();
  });

  await test.step("2 submit five tasks without the composer blocking", async () => {
    const started = Date.now();
    const ids = [
      await assignTracked(page, botId, ALPHA),
      await assignTracked(page, botId, ARTIFACT),
      await assignTracked(page, botId, PONG),
      await assignTracked(page, botId, REMEMBER),
      await assignTracked(page, botId, HELLO, false),
    ];
    const elapsed = Date.now() - started;
    notes.push(`burst-ms ${elapsed}`);
    expect(elapsed).toBeLessThan(25_000);
    await expect(page.getByTestId("composer")).toBeEnabled();
    await shot(page, "chat-task-running");
    await openPane(page, "Tasks");
    await expect(page.getByTestId("task-list")).toContainText(/queued|running|completed/i);
    await shot(page, "tasks-running");
    const hello = await expectDone(page, botId, ids[4]);
    expect(resultText(hello).toLowerCase()).toContain("teammate");
    const terminal = await expectDone(page, botId, ids[2]);
    expect(resultText(terminal).toLowerCase()).toContain("pong");
    const memory = await expectDone(page, botId, ids[3]);
    expect(resultText(memory).toLowerCase()).toContain("saved");
    const alpha = await expectDone(page, botId, ids[0], 180_000);
    expect(resultText(alpha)).toContain("Alpha");
    const artifact = await expectDone(page, botId, ids[1], 180_000);
    expect(resultText(artifact).toLowerCase()).toContain("artifact");
  });

  await test.step("8 terminal file and upload download", async () => {
    const notesListing = await page.request.get(`/api/bots/${botId}/files?path=/workspace/notes`);
    expect(notesListing.ok()).toBeTruthy();
    expect(await notesListing.text()).toContain("ping.txt");
    await openPane(page, "Files/Media");
    await page.locator("#file-path").fill("/workspace/handoff.txt");
    await page.getByTestId("file-upload").setInputFiles({
      name: "handoff.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("handoff-ok\n"),
    });
    await expect(page.getByTestId("file-list")).toContainText("handoff.txt", { timeout: 30_000 });
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("file-list").locator("li", { hasText: "handoff.txt" }).getByRole("link", { name: "Download" }).click(),
    ]);
    expect(fs.readFileSync(await download.path(), "utf8")).toContain("handoff-ok");
  });

  await test.step("memory and 7 artifact", async () => {
    const recall = await assignTracked(page, botId, "What editor do I prefer?");
    const recalled = await expectDone(page, botId, recall);
    expect(resultText(recalled)).toContain("Helix");
    await openPane(page, "Memory");
    await expect(page.getByTestId("memory-list")).toContainText("Helix");
    await page.getByTestId("memory-input").fill("The survey waypoint is the north gate.");
    await page.getByTestId("memory-save").click();
    await expect(page.getByTestId("memory-list")).toContainText("north gate");

    await openPane(page, "Files/Media");
    await expect(page.getByTestId("artifact-list")).toContainText("field-notes.txt");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("artifact-list").locator("li", { hasText: "field-notes.txt" }).getByRole("link", { name: "Download" }).click(),
    ]);
    const body = fs.readFileSync(await download.path(), "utf8");
    expect(body).toContain("north gate");
    assertClean("artifact", body);
  });

  await test.step("3 four browser tabs and live noVNC", async () => {
    const started = Date.now();
    const ids = [
      await assignTracked(page, botId, BETA),
      await assignTracked(page, botId, GAMMA),
      await assignTracked(page, botId, DELTA),
      await assignTracked(page, botId, ALPHA),
    ];
    const finished = [];
    for (const id of ids) finished.push(await expectDone(page, botId, id, 180_000));
    const elapsed = (Date.now() - started) / 1000;
    notes.push(`parallel-browser-s ${elapsed.toFixed(1)}`);
    expect(elapsed).toBeLessThan(70);
    expect(finished.map((task) => resultText(task)).join(" ")).toContain("Beta");
    await openPane(page, "Computer");
    await expect(page.getByTestId("computer-tab")).toHaveAttribute("data-vnc-state", "connected", { timeout: 60_000 });
    await expect(page.locator('[aria-label="Bot desktop"] canvas')).toBeVisible();
    await expect.poll(async () => page.getByTestId("browser-page").count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(4);
    const pages = await page.getByTestId("browser-page").count();
    notes.push(`browser-pages ${pages}`);
    expect(pages).toBeGreaterThanOrEqual(4);
    await page.waitForTimeout(1500);
    await shot(page, "live-computer");
  });

  await test.step("9 code agent", async () => {
    const id = await assignTracked(page, botId, CODE);
    const task = await expectDone(page, botId, id, 180_000);
    expect(resultText(task).toLowerCase()).toContain("passed");
  });

  await test.step("12 approval blocks delete", async () => {
    const id = await assignTracked(page, botId, DELETE_FILE);
    await expect(page.getByTestId("approval-card").filter({ hasText: "delete_file" })).toBeVisible({ timeout: 90_000 });
    await shot(page, "approvals");
    await page.getByTestId("approve-once").click();
    const task = await expectDone(page, botId, id);
    expect(resultText(task).toLowerCase()).toContain("delete");
  });

  await test.step("10 save skill and replay with zero model calls", async () => {
    await openPane(page, "Tasks");
    const row = page.getByTestId("task-item").filter({ hasText: "ping.txt" }).first();
    await row.getByTestId("save-skill").click();
    await openPane(page, "Skills");
    await expect(page.getByTestId("skill-list")).toContainText("ping.txt");
    await shot(page, "skills");
    await page.getByTestId("skill-replay").click();
    let found: TaskRow | undefined;
    const replayStart = Date.now();
    while (Date.now() - replayStart < 20_000) {
      found = (await listTasks(page, botId)).find((task) => (task.title || "").startsWith("Replay "));
      if (found) break;
      await page.waitForTimeout(500);
    }
    expect(found).toBeTruthy();
    const done = await expectDone(page, botId, found!.id);
    expect(done.modelCalls ?? 0).toBe(0);
    await openPane(page, "Tasks");
    await expect(page.getByTestId("task-item").filter({ hasText: "Replay" }).first()).toContainText("Model calls 0");
  });

  await test.step("11 routine fires with the workspace closed", async () => {
    await openPane(page, "Routines");
    await page.getByTestId("routine-name").fill("Hourly hello");
    await page.getByTestId("routine-cron").fill("0 * * * *");
    await page.getByTestId("routine-instruction").fill(HELLO);
    await page.getByTestId("routine-create").click();
    await expect(page.getByRole("tabpanel").getByText("Hourly hello", { exact: true })).toBeVisible();
    await shot(page, "routines");
    const listing = await page.request.get(`/api/bots/${botId}/routines`);
    expect(listing.ok()).toBeTruthy();
    const routines = (await listing.json()) as Array<{ id: string; name: string }>;
    const routine = routines.find((item) => item.name === "Hourly hello");
    expect(routine).toBeTruthy();
    const patched = await page.request.patch(`/api/routines/${routine!.id}`, {
      data: { nextRunAt: "2000-01-01T00:00:00Z" },
    });
    expect(patched.ok()).toBeTruthy();
    await page.goto("/system");
    await expect(page).toHaveURL(/\/system/);
    const start = Date.now();
    let routineTask: TaskRow | undefined;
    while (Date.now() - start < 40_000) {
      routineTask = (await listTasks(page, botId)).find((task) => task.title === "Hourly hello");
      if (routineTask?.status === "completed") break;
      await page.waitForTimeout(1000);
    }
    expect(routineTask?.status).toBe("completed");
    await page.goto(botUrl);
  });

  await test.step("5 and 6 takeover, attention, unrelated task continues", async () => {
    const captcha = await assignTracked(page, botId, CAPTCHA);
    const start = Date.now();
    let waiting: TaskRow | undefined;
    while (Date.now() - start < 120_000) {
      waiting = (await listTasks(page, botId)).find((task) => task.id === captcha);
      if (waiting?.status === "waiting_human") break;
      if (waiting && ["failed", "completed"].includes(waiting.status)) break;
      await page.waitForTimeout(1000);
    }
    expect(waiting?.status).toBe("waiting_human");
    const side = await assignTracked(page, botId, STILL);
    const sideDone = await expectDone(page, botId, side);
    expect(resultText(sideDone).toLowerCase()).toContain("pong");
    const stillWaiting = (await listTasks(page, botId)).find((task) => task.id === captcha);
    expect(stillWaiting?.status).toBe("waiting_human");

    await openPane(page, "Computer");
    await expect(page.getByTestId("attention-banner")).toBeVisible();
    await page.getByTestId("take-control").click();
    await expect(page.getByText("The pointer is yours.")).toBeVisible();
    await expect(page.getByText("You have the computer.")).toBeVisible();
    await expect(page.getByTestId("computer-tab")).toHaveAttribute("data-vnc-state", "connected", { timeout: 30_000 });
    await page.waitForTimeout(1000);
    await shot(page, "take-control");
    await page.getByTestId("human-click").click();
    await page.getByTestId("resolve-attention").click();
    await page.getByTestId("hand-back").click();
    await expect(page.getByText("View only, until you take control.")).toBeVisible();
    await expect(page.getByText("The agent has the computer.")).toBeVisible();
    await expect(page.getByTestId("human-click")).toHaveCount(0);
    await expect(page.getByTestId("computer-tab")).toHaveAttribute("data-vnc-state", "connected", { timeout: 30_000 });
    const cleared = await expectDone(page, botId, captcha, 120_000);
    expect(resultText(cleared).toLowerCase()).not.toContain("captcha");
  });

  await test.step("18 and 19 secrets for type_secret", async () => {
    await openSecrets(page);
    await addSecret(page, {
      name: "password",
      namespace: "university",
      type: "PASSWORD",
      value: PORTAL_PASSWORD,
      domains: "http://portal.example.edu:8099",
      tools: "browser.type_secret",
    });
    await addSecret(page, {
      name: "token",
      namespace: "github",
      type: "TOKEN",
      value: GITHUB,
      tools: "setup_env",
    });
    await addSecret(page, {
      name: "registry",
      namespace: "project",
      type: "GENERIC",
      value: REGISTRY,
      tools: "setup_env",
    });
    await page.goto(botUrl);
  });

  await test.step("19 type_secret allow, deny, and injection", async () => {
    const loginTask = await assignTracked(page, botId, LOGIN);
    const credential = page.getByTestId("approval-card").filter({ hasText: "type_secret" });
    await expect(credential).toBeVisible({ timeout: 90_000 });
    await credential.getByTestId("approve-domain").click();
    await expect(credential).toHaveAttribute("data-decided", "true");
    await expect(credential.getByTestId("approve-once")).toHaveCount(0);
    const typed = await expectDone(page, botId, loginTask, 180_000);
    expect(resultText(typed).toLowerCase()).toContain("typed");
    const injected = await expectDone(page, botId, await assignTracked(page, botId, INJECT), 180_000);
    expect(resultText(injected).toLowerCase()).toContain("denied");
    for (const probe of [PROBE_OPENROUTER, PROBE_PHISH]) {
      await expectDone(page, botId, await assignTracked(page, botId, probe), 180_000);
    }
    const setupTask = await assignTracked(page, botId, SETUP);
    const setupCard = page.getByTestId("approval-card").filter({ hasText: "setup_env" });
    await expect(setupCard).toBeVisible({ timeout: 90_000 });
    await setupCard.getByTestId("approve-once").click();
    const setup = await expectDone(page, botId, setupTask, 120_000);
    expect(resultText(setup)).not.toContain(REGISTRY);
  });

  await test.step("22 reactions", async () => {
    const before = (await listTasks(page, botId)).length;
    const thanks = await assignTracked(page, botId, "thanks!", false);
    await expectDone(page, botId, thanks);
    const pill = page.locator('[data-testid="reaction-pill"][data-emoji="👍"][data-actor="bot"]');
    await expect(pill).toBeVisible({ timeout: 30_000 });
    const assistants = page.locator('[data-testid="message-item"][data-role="assistant"]');
    const count = await assistants.count();
    for (let index = 0; index < count; index += 1) {
      const text = (await assistants.nth(index).innerText()).trim();
      expect(text.length).toBeGreaterThan(0);
    }
    const message = assistants.filter({ has: page.locator('[data-testid="reaction-picker"]') }).last();
    const picker = message.locator('[data-testid="reaction-picker"]');
    await picker.getByRole("button", { name: "👍" }).click();
    await expect(message.locator('[data-testid="reaction-pill"][data-emoji="👍"][data-actor="user"]')).toBeVisible();
    await picker.getByRole("button", { name: "👍" }).click();
    await expect(message.locator('[data-testid="reaction-pill"][data-actor="user"]')).toHaveCount(0);
    await picker.getByRole("button", { name: "❤️" }).click();
    await expect(message.locator('[data-testid="reaction-pill"][data-emoji="❤️"][data-actor="user"]')).toBeVisible();
    await expect(message.locator('[data-testid="reaction-pill"][data-actor="user"]')).toHaveCount(1);
    await page.waitForTimeout(1500);
    expect((await listTasks(page, botId)).length).toBe(before + 1);
    await shot(page, "reactions");
  });

  await test.step("crash recovery re-lease", async () => {
    const id = await assignTracked(page, botId, HOLD);
    const start = Date.now();
    let running = false;
    while (Date.now() - start < 40_000) {
      const task = (await listTasks(page, botId)).find((row) => row.id === id);
      if (task?.status === "running") {
        running = true;
        break;
      }
      if (task && ["completed", "failed"].includes(task.status)) break;
      await page.waitForTimeout(300);
    }
    expect(running).toBeTruthy();
    capture(["docker", "restart", "teammates-agent-1"], 180_000);
    const done = await expectDone(page, botId, id, 120_000);
    expect(resultText(done)).toContain("Recovered");
    const attempt = capture([
      "docker",
      "exec",
      "teammates-postgres-1",
      "psql",
      "-U",
      "agent",
      "-d",
      "agent",
      "-tA",
      "-c",
      `SELECT attempt FROM tasks WHERE id='${id}'`,
    ]).trim();
    notes.push(`recovery-attempt ${attempt}`);
    expect(Number(attempt)).toBeGreaterThanOrEqual(2);
    const file = await page.request.get(`/api/bots/${botId}/files/raw?path=/workspace/recovery-done.txt`);
    expect(file.ok()).toBeTruthy();
    expect(await file.text()).toContain("recovered");
  });

  await test.step("4 login cookie survives computer restart", async () => {
    const slug = await computerSlug(page, botId);
    capture([
      "docker",
      "exec",
      slug,
      "python3",
      "-c",
      "import json,urllib.request,os; body=json.dumps({'name':'teammates_probe','value':'kept','url':'http://portal.example.edu:8099/'}).encode(); req=urllib.request.Request('http://127.0.0.1:7700/desktops/'+os.environ['COMPUTER_ID']+'/cookies', data=body, headers={'Authorization':'Bearer '+os.environ['COMPUTER_TOKEN'],'Content-Type':'application/json'}); urllib.request.urlopen(req)",
    ]);
    capture(["docker", "restart", slug], 180_000);
    let raw = "";
    const start = Date.now();
    while (Date.now() - start < 50_000) {
      const result = spawnSync(
        "sudo",
        [
          "docker",
          "exec",
          slug,
          "python3",
          "-c",
          "import urllib.request,os; req=urllib.request.Request('http://127.0.0.1:7700/desktops/'+os.environ['COMPUTER_ID']+'/cookies', headers={'Authorization':'Bearer '+os.environ['COMPUTER_TOKEN']}); print(urllib.request.urlopen(req).read().decode())",
        ],
        { encoding: "utf8", timeout: 20_000 },
      );
      raw = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      if (raw.includes("teammates_probe")) break;
      spawnSync("sleep", ["3"]);
    }
    expect(raw).toContain("teammates_probe");
    await page.goto(botUrl);
    await openPane(page, "Computer");
    await expect(page.getByTestId("computer-tab")).toHaveAttribute("data-vnc-state", "connected", { timeout: 60_000 });
  });

  await test.step("13 API restart keeps completed tasks", async () => {
    const hello = await expectDone(page, botId, await assignTracked(page, botId, HELLO, false));
    capture(["docker", "restart", "teammates-api-1"], 180_000);
    waitHealth();
    await page.goto(botUrl);
    if (await page.getByTestId("login-username").isVisible().catch(() => false)) await login(page);
    await page.goto(botUrl);
    const rows = await listTasks(page, botId);
    expect(rows.some((task) => task.id === hello.id && task.status === "completed")).toBeTruthy();
  });

  await test.step("18 rotate, revoke, delete and 20 audit", async () => {
    await page.goto("/settings/secrets");
    page.once("dialog", (dialog) => dialog.accept(OPENROUTER));
    await page.getByTestId("rotate-secret").click();
    await expect(page.getByTestId("masked-suffix")).toContainText("8Kx2");
    await expect(page.getByTestId("secret-usage")).toContainText("secret.rotated", { timeout: 20_000 });

    const github = page.locator('[data-ref="secret://github/token"]');
    await github.getByTestId("secret-revoke").click();
    await expect(github).toContainText("revoked");
    await expect(page.getByTestId("secret-usage")).toContainText("secret.revoked");
    await github.getByTestId("secret-row-delete").click();
    await expect(page.locator('[data-ref="secret://github/token"]')).toHaveCount(0);
    await expect(page.getByTestId("secret-usage")).toContainText("secret.deleted");

    const registry = page.locator('[data-ref="secret://project/registry"]');
    await registry.getByTestId("secret-revoke").click();
    await expect(page.getByTestId("secret-usage")).toContainText("secret.revoked");
    await page.goto(botUrl);
    const revokedSetup = await assignTracked(page, botId, SETUP);
    const revokedCard = page.getByTestId("approval-card").filter({ hasText: "setup_env" });
    await expect(revokedCard).toBeVisible({ timeout: 90_000 });
    await revokedCard.getByTestId("approve-once").click();
    const denied = await expectDone(page, botId, revokedSetup, 120_000);
    assertClean("revoked setup", resultText(denied));
    await page.goto("/settings/secrets");
    await page.locator('[data-ref="secret://project/registry"]').getByTestId("secret-select").click();
    await expect(page.getByTestId("secret-usage")).toContainText("secret.denied");
    await page.locator('[data-ref="secret://university/password"]').getByTestId("secret-select").click();
    const usage = page.getByTestId("secret-usage");
    await expect(usage).toContainText("secret.created");
    await expect(usage).toContainText(/secret\.used|secret\.denied/);
    await shot(page, "secrets-audit");
  });

  await test.step("15 metrics", async () => {
    await page.getByTestId("nav-system").click();
    await expect(page.getByTestId("metrics-model-calls")).toContainText(/\d+/);
    await expect(page.getByTestId("metrics-cost")).toContainText("$");
    await expect(page.getByTestId("metrics-latency")).toContainText("ms");
    await expect
      .poll(async () => {
        const response = await page.request.get("/api/usage");
        const body = (await response.json()) as { computerMemoryBytes?: number };
        return Number(body.computerMemoryBytes ?? 0);
      }, { timeout: 45_000 })
      .toBeGreaterThan(0);
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page.getByTestId("metrics-memory")).toContainText(/[1-9]\d* MB/);
    await shot(page, "system-metrics");
  });

  await test.step("17 leak scan and 14/21 backup restore", async () => {
    assertClean("visible ui", await page.locator("body").innerText());
    for (const path of ["/api/secrets", "/api/usage", "/api/model-requests", `/api/bots/${botId}/workspace`, `/api/bots/${botId}/memories`]) {
      const response = await page.request.get(path);
      expect(response.ok()).toBeTruthy();
      assertClean(path, await response.text());
    }
    const slug = await computerSlug(page, botId);
    let logs = "";
    for (const name of ["teammates-api-1", "teammates-agent-1", "teammates-mock-openrouter-1", slug]) {
      logs += capture(["docker", "logs", name], 60_000);
    }
    assertClean("docker logs", logs);
    const columns = capture([
      "docker",
      "exec",
      "teammates-postgres-1",
      "psql",
      "-U",
      "agent",
      "-d",
      "agent",
      "-tA",
      "-c",
      "SELECT coalesce(string_agg(content,' '),'') FROM messages; SELECT coalesce(string_agg(prompt_json::text,' '),'') FROM model_requests; SELECT coalesce(string_agg(result::text,' '),'') FROM task_steps;",
    ]);
    assertClean("database text", columns);
    const restore = spawnSync("python3", [path.join(__dirname, "restore_check.py")], { encoding: "utf8", timeout: 180_000 });
    expect(restore.stdout || "").toContain("restore-ok");
    expect(restore.status).toBe(0);
  });

  await test.step("sidebar, info pane tabs, theme, and command palette", async () => {
    const tabs = ["Overview", "Computer", "Routines", "Files/Media", "Skills", "Memory", "Tasks"] as const;
    await page.goto("/login");
    await shot(page, "dark-login");
    await page.goto("/");
    await shot(page, "dark-home");
    await page.getByTestId("sidebar").getByRole("link").filter({ hasText: "Clerk" }).first().click();
    await expect(page.getByTestId("composer")).toBeVisible();
    await shot(page, "dark-chat");
    for (const tab of tabs) {
      await openPane(page, tab);
      await expect(page.getByTestId("info-pane").getByRole("tab", { name: tab, exact: true })).toHaveAttribute("data-state", "active");
      await shot(page, `dark-tab-${tab.toLowerCase().replace("/", "-")}`);
    }
    await page.keyboard.press("Control+k");
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await shot(page, "dark-command-palette");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("command-palette")).toHaveCount(0);

    await page.goto("/");
    const atlas = `Atlas ${Date.now().toString().slice(-4)}`;
    await page.getByTestId("new-bot").click();
    await page.getByRole("menuitem", { name: "New teammate" }).click();
    await page.getByTestId("bot-name").fill(atlas);
    await page.getByTestId("bot-advanced-toggle").click();
    await page.getByTestId("bot-role").fill("Second teammate");
    await page.getByTestId("bot-instructions").fill("Same tabs as every other bot.");
    await page.getByTestId("bot-create").click();
    await page.getByTestId("sidebar").getByRole("link", { name: atlas }).click({ timeout: 180_000 });
    await expect(page).toHaveURL(/\/bots\//);
    await expect(page.getByTestId("bot-name-button")).toContainText(atlas);
    createdBotIds.push(page.url().split("/bots/")[1]?.split(/[?#]/)[0] ?? "");
    for (const tab of tabs) {
      await openPane(page, tab);
      await expect(page.getByTestId("info-pane").getByRole("tab", { name: tab, exact: true })).toHaveAttribute("data-state", "active");
    }
    await shot(page, "dark-second-bot");

    await page.getByTestId("account-button").click();
    await shot(page, "dark-settings-general");
    await page.getByTestId("theme-light").click();
    await expect(page.locator("html")).toHaveClass(/light/);
    await page.goto("/login");
    await shot(page, "light-login");
    await page.goto("/");
    await shot(page, "light-home");
    await page.goto(botUrl);
    await shot(page, "light-chat");
    for (const tab of tabs) {
      await openPane(page, tab);
      await shot(page, `light-tab-${tab.toLowerCase().replace("/", "-")}`);
    }
    await page.getByTestId("account-button").click();
    await shot(page, "light-settings-general");
    for (const [tab, file] of [
      ["Vault", "secrets"],
      ["Computer", "computer"],
      ["Usage & Billing", "usage"],
      ["System", "system"],
    ] as const) {
      await page.getByRole("tab", { name: tab, exact: true }).click();
      await shot(page, `light-settings-${file}`);
    }
    await page.getByRole("tab", { name: "General", exact: true }).click();
    await page.getByTestId("theme-dark").click();
    await expect(page.locator("html")).not.toHaveClass(/light/);
    await page.getByRole("tab", { name: "Vault", exact: true }).click();
    await shot(page, "dark-settings-secrets");
    await page.getByRole("tab", { name: "Computer", exact: true }).click();
    await shot(page, "dark-settings-computer");
    await page.getByRole("tab", { name: "Usage & Billing", exact: true }).click();
    await expect(page.getByTestId("usage-report")).toBeVisible();
    await shot(page, "dark-settings-usage");
    await page.getByRole("tab", { name: "System", exact: true }).click();
    await shot(page, "dark-settings-system");
    await expect(page.getByTestId("admin-health")).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.getByTestId("sidebar-toggle").click();
    await expect(page.getByTestId("new-bot")).toBeVisible();
    await shot(page, "dark-mobile-sidebar");
    await page.setViewportSize({ width: 1280, height: 720 });
  });

  const stats = capture(["docker", "stats", "--no-stream", "--format", "{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}"]);
  fs.mkdirSync("/opt/cursor/artifacts", { recursive: true });
  fs.writeFileSync("/opt/cursor/artifacts/docker-stats.txt", `${stats}\n${notes.join("\n")}\n`);
  fs.writeFileSync("/workspace/docs/evidence/e2e-notes.txt", `${notes.join("\n")}\n${stats}\n`);
});
