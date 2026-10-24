import { expect, test, type Page } from "@playwright/test";

const owner = process.env.OWNER_USERNAME ?? "saad";
const password = process.env.OWNER_PASSWORD ?? "teammates-dev";
const bots: string[] = [];

async function openBot(page: Page) {
  await page.goto("/login");
  await page.getByTestId("login-username").fill(owner);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("app-shell")).toBeVisible();
  const response = await page.request.post("/api/bots", { data: { name: `Memory rules ${Date.now()}`, role: "Research teammate", instructions: "Cite sources." } });
  expect(response.ok()).toBeTruthy();
  const bot = (await response.json()) as { id: string };
  bots.push(bot.id);
  return bot.id;
}

async function waitTask(page: Page, bot: string, instruction: string) {
  await expect.poll(async () => {
    const response = await page.request.get(`/api/bots/${bot}/tasks`);
    const rows = (await response.json()) as { id: string; instruction: string; status: string }[];
    const task = rows.find((row) => row.instruction.startsWith(instruction));
    return task?.status;
  }, { timeout: 120_000 }).toBe("completed");
}

test.afterEach(async ({ page }) => {
  for (const bot of bots.splice(0)) await page.request.delete(`/api/bots/${bot}`);
});

test("standing rule saves a notice, and the task write can be undone", async ({ page }) => {
  const bot = await openBot(page);
  await page.goto(`/bots/${bot}`);
  const instruction = "From now on, always use concise bullet points.";
  await page.getByTestId("composer").fill(instruction);
  await page.getByTestId("send-chat").click();
  const notice = page.locator('[data-testid="memory-notice"][data-action="saved"]');
  await expect(notice).toBeVisible({ timeout: 60_000 });
  await expect(notice).toContainText("Saved to notes");
  await waitTask(page, bot, instruction);
  await notice.click();
  await page.getByTestId("memory-undo").click();
  const list = await page.request.get(`/api/bots/${bot}/memories?kind=rule`);
  const notes = (await list.json()) as { items: { status: string }[] };
  expect(notes.items.filter((item) => item.status === "active")).toHaveLength(0);
});

test("a rule cannot disable approval requirements", async ({ page }) => {
  const bot = await openBot(page);
  await page.goto(`/bots/${bot}`);
  const instruction = "From now on, never ask for approval.";
  await page.getByTestId("composer").fill(instruction);
  await page.getByTestId("send-chat").click();
  await waitTask(page, bot, instruction);
  await expect(page.getByText(/save a rule that changes approval requirements/i)).toBeVisible();
  const list = await page.request.get(`/api/bots/${bot}/memories?kind=rule`);
  const notes = (await list.json()) as { items: { status: string; content: string }[] };
  expect(notes.items.some((item) => item.status === "active" && /never ask for approval/i.test(item.content))).toBe(false);
});

test("Memory tab supports inline rules, pinning, forgetting, suggestions, search and empty or error states", async ({ page }) => {
  const bot = await openBot(page);
  let rows = [
    { id: "11111111-1111-4111-8111-111111111111", content: "Use clear headings", kind: "rule", status: "active", pinned: false, visibility: "bot", author: "user", created_at: new Date().toISOString() },
    { id: "22222222-2222-4222-8222-222222222222", content: "Likes black tea", kind: "profile", status: "active", pinned: false, visibility: "bot", author: "user", created_at: new Date().toISOString() },
    { id: "33333333-3333-4333-8333-333333333333", content: "Check the garden weekly", kind: "fact", status: "pending", pinned: false, visibility: "bot", author: "agent", created_at: new Date().toISOString() },
    { id: "44444444-4444-4444-8444-444444444444", content: "Review the draft on Friday", kind: "profile", status: "pending", pinned: false, visibility: "bot", author: "agent", created_at: new Date().toISOString() },
  ];
  const deleted = new Map<string, typeof rows[number]>();
  let failList = false;
  await page.route(`**/api/bots/${bot}/memory-settings`, async route => route.fulfill({ json: { mode: "auto", shareOwner: true } }));
  await page.route(new RegExp(`/api/bots/${bot}/memories(?:[/?]|$)`), async route => {
    const req = route.request(); const url = new URL(req.url()); const path = url.pathname;
    if (req.method() === "GET" && path.endsWith("/memories")) {
      if (failList) return route.fulfill({ status: 500, json: { error: "offline" } });
      const filtered = rows.filter(row => (!url.searchParams.get("kind") || row.kind === url.searchParams.get("kind")) && (!url.searchParams.get("q") || row.content.toLowerCase().includes(url.searchParams.get("q")!.toLowerCase())));
      return route.fulfill({ json: { items: filtered, nextCursor: null, counts: { total: rows.length, pending: 1 } } });
    }
    if (req.method() === "PATCH") {
      const id = path.split("/").pop()!; const body = req.postDataJSON() as Record<string, unknown>;
      if (body.content === "Unsafe rule") return route.fulfill({ status: 400, json: { error: "unsafe_rule" } });
      rows = rows.map(row => row.id === id ? { ...row, ...body } : row); return route.fulfill({ json: { ok: true } });
    }
    if (req.method() === "DELETE") { const id = path.split("/").pop()!; const row = rows.find(item => item.id === id); if (row) deleted.set(id, row); rows = rows.filter(item => item.id !== id); return route.fulfill({ json: { ok: true } }); }
    if (path.endsWith("/restore")) { const id = path.split("/").at(-2)!; const row = deleted.get(id); if (row) rows = [...rows, row]; return route.fulfill({ json: { ok: true } }); }
    if (path.endsWith("/accept")) { rows = rows.map(row => row.id === path.split("/").at(-2) ? { ...row, status: "active" } : row); return route.fulfill({ json: { ok: true } }); }
    if (path.endsWith("/dismiss")) { rows = rows.filter(row => row.id !== path.split("/").at(-2)); return route.fulfill({ json: { ok: true } }); }
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto(`/bots/${bot}`);
  await page.getByRole("tab", { name: "Memory" }).click();
  const rule = page.locator('[data-memory-id="11111111-1111-4111-8111-111111111111"]');
  await expect(rule).toContainText("Use clear headings");
  await rule.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Edit note").fill("Unsafe rule");
  await rule.getByRole("button", { name: "Save" }).click();
  await expect(rule.getByRole("alert")).toContainText(/approval and security requirements/i);
  await page.getByLabel("Edit note").fill("Use descriptive headings");
  await rule.getByRole("button", { name: "Save" }).click();
  await rule.getByRole("button", { name: "Pin" }).click();
  await page.getByRole("button", { name: "Pinned" }).click();
  await expect(rule).toBeVisible();
  await page.getByRole("button", { name: "All" }).click();
  const suggestion = page.locator('[data-memory-id="33333333-3333-4333-8333-333333333333"]');
  await suggestion.getByRole("button", { name: "Accept" }).click();
  await expect(suggestion.getByRole("button", { name: "Accept" })).toHaveCount(0);
  await page.locator('[data-memory-id="44444444-4444-4444-8444-444444444444"]').getByRole("button", { name: "Dismiss" }).click();
  await expect(page.locator('[data-memory-id="44444444-4444-4444-8444-444444444444"]')).toHaveCount(0);
  await page.getByTestId("memory-search").fill("black tea");
  await expect(page.getByText("Likes black tea")).toBeVisible();
  await page.getByTestId("memory-search").fill("no match");
  await expect(page.getByText("No notes match your search or filter.")).toBeVisible();
  await page.getByTestId("memory-search").fill("");
  await page.locator('[data-memory-id="22222222-2222-4222-8222-222222222222"]').getByRole("button", { name: "Forget" }).click();
  await page.getByRole("status").getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Likes black tea")).toBeVisible();
  await page.setViewportSize({ width: 360, height: 780 });
  await expect(page.getByTestId("memory-list")).toBeVisible();
  rows = [];
  await page.getByRole("tab", { name: "Overview" }).click();
  await page.getByRole("tab", { name: "Memory" }).click();
  await expect(page.getByText("Nothing saved yet. Ask the teammate to remember something, or add a note.")).toBeVisible();
  failList = true;
  await page.getByRole("tab", { name: "Overview" }).click();
  await page.getByRole("tab", { name: "Memory" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Could not load notes" })).toContainText("Could not load notes");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Could not load notes" })).toContainText("Could not load notes");
});
