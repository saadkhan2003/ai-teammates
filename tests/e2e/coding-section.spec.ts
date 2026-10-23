import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { login } from "./helpers";

function psql(sql: string) {
  const args = ["exec", "-i", "teammates-postgres-1", "psql", "-U", "agent", "-d", "agent", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A", "-c", sql];
  const result = spawnSync("sudo", ["docker", ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "psql failed");
  return result.stdout.trim();
}

async function seed(page: import("@playwright/test").Page) {
  await login(page);
  const response = await page.request.post("/api/bots", { data: { name: `Code ${Date.now().toString().slice(-5)}`, avatarColor: "#3b82f6" } });
  expect(response.ok()).toBeTruthy();
  const bot = (await response.json()) as { id: string };
  const rows: Array<[string, string, string, string, string]> = [
    ["Add retry to uploads", "running", "", "", "pending"],
    ["Fix flaky login test", "completed", "5", "open", "passing"],
    ["Bump dependencies", "completed", "7", "merged", "passing"],
    ["Refactor router", "failed", "", "", "failing"],
    ["Write docs", "completed", "", "", "unknown"],
  ];
  const diff = "diff --git a/app.py b/app.py\\n--- a/app.py\\n+++ b/app.py\\n@@ -1 +1 @@\\n-old line\\n+new line";
  for (const [title, status, pr, prState, ci] of rows) {
    const task = psql(`INSERT INTO tasks (bot_id, title, instruction, status) VALUES ('${bot.id}', '${title}', 'x', '${status}') RETURNING id;`).split("\n")[0];
    psql(`INSERT INTO coding_items (bot_id, task_id, title, branch, repo_url, pr_number, pr_url, pr_state, ci_state, changed_files, files, diff, tests_ok, tests_summary)
      VALUES ('${bot.id}', '${task}', '${title}', 'task/${task.slice(0, 6)}', 'https://github.com/acme/widgets.git', ${pr || "NULL"}, '${pr ? `https://github.com/acme/widgets/pull/${pr}` : ""}', '${prState}', '${ci}', 3, '["app.py","tests/test_app.py","README.md"]'::jsonb, E'${diff}', true, '12 passed in 0.4s');`);
  }
  return bot.id;
}

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test("coding rows show status, PR, CI and files, with an Open menu and a diff view", async ({ page }) => {
  const botId = await seed(page);
  try {
    await page.goto(`/bots/${botId}`);
    const section = page.getByTestId("coding-section");
    await expect(section).toBeVisible();
    const rows = section.getByTestId("coding-row");
    await expect(rows).toHaveCount(5);
    const ready = rows.filter({ hasText: "Fix flaky login test" });
    await expect(ready.getByTestId("coding-status")).toHaveText("Ready for review");
    await expect(ready.getByTestId("coding-pr")).toHaveText("#5");
    await expect(ready.getByTestId("coding-ci")).toHaveText("CI passing");
    await expect(ready.getByTestId("coding-files")).toHaveText("3 files");
    await expect(rows.filter({ hasText: "Add retry" }).getByTestId("coding-status")).toHaveText("Running");
    await expect(rows.filter({ hasText: "Bump dependencies" }).getByTestId("coding-status")).toHaveText("Merged");
    await expect(rows.filter({ hasText: "Refactor router" }).getByTestId("coding-status")).toHaveText("Failed");
    await expect(rows.filter({ hasText: "Write docs" }).getByTestId("coding-status")).toHaveText("Finished");

    const open = ready.getByTestId("coding-open");
    await expect(open).toHaveCSS("opacity", "0");
    await ready.hover();
    await expect(open).toHaveCSS("opacity", "1");
    await page.screenshot({ path: "/workspace/ai-teammates-live/shots/11-coding-hover.png" });
    await open.click();
    await expect(page.getByTestId("coding-menu-pr")).toHaveAttribute("href", "https://github.com/acme/widgets/pull/5");
    for (const id of ["cursor", "vscode", "zed"]) await expect(page.getByTestId(`coding-menu-${id}`)).toBeVisible();
    await page.screenshot({ path: "/workspace/ai-teammates-live/shots/11-coding-menu.png" });

    await page.getByTestId("coding-menu-copy").click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/^git clone -b task\/[0-9a-f]{6} https:\/\/github.com\/acme\/widgets.git$/);

    await ready.hover();
    await ready.getByTestId("coding-open").click();
    await page.getByTestId("coding-menu-diff").click();
    const dialog = page.getByTestId("coding-diff");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("coding-tests")).toContainText("Tests passed");
    await expect(dialog.getByTestId("coding-tests")).toContainText("12 passed");
    await expect(dialog.getByTestId("coding-file-list")).toContainText("tests/test_app.py");
    await expect(dialog.getByTestId("coding-diff-text")).toContainText("+new line");
    await page.screenshot({ path: "/workspace/ai-teammates-live/shots/11-coding-diff.png" });
  } finally {
    await page.request.delete(`/api/bots/${botId}`);
  }
});

test("editors turned off in Settings disappear from the Open menu", async ({ page }) => {
  const botId = await seed(page);
  try {
    await page.goto("/settings");
    await page.getByTestId("editor-vscode").click();
    await page.getByTestId("editor-zed").click();
    await expect(page.getByTestId("editor-vscode")).toHaveAttribute("aria-checked", "false");
    await page.goto(`/bots/${botId}`);
    const row = page.getByTestId("coding-row").filter({ hasText: "Fix flaky login test" });
    await row.hover();
    await row.getByTestId("coding-open").click();
    await expect(page.getByTestId("coding-menu-cursor")).toBeVisible();
    await expect(page.getByTestId("coding-menu-vscode")).toHaveCount(0);
    await expect(page.getByTestId("coding-menu-zed")).toHaveCount(0);
  } finally {
    await page.evaluate(() => window.localStorage.removeItem("teammates-editors"));
    await page.request.delete(`/api/bots/${botId}`);
  }
});

test("coding list API is owner-scoped and the section shows skeleton and error states", async ({ page }) => {
  const botId = await seed(page);
  try {
    const list = await page.request.get(`/api/bots/${botId}/coding`);
    expect(list.ok()).toBeTruthy();
    const items = (await list.json()) as Array<{ id: string; status: string; prNumber: number | null; changedFiles: number }>;
    expect(items).toHaveLength(5);
    expect(items.map((i) => i.status).sort()).toEqual(["failed", "finished", "merged", "ready_for_review", "running"]);
    const detail = (await (await page.request.get(`/api/coding/${items[0].id}`)).json()) as { checkout: string; files: string[] };
    expect(detail.files).toHaveLength(3);
    expect(detail.checkout).toMatch(/^git clone -b /);
    expect((await page.request.get(`/api/coding/00000000-0000-0000-0000-000000000000`)).status()).toBe(404);

    let fail = true;
    await page.route(`**/api/bots/${botId}/coding`, async (route) => {
      await new Promise((r) => setTimeout(r, 600));
      if (fail) await route.fulfill({ status: 500, body: "{}" });
      else await route.continue();
    });
    await page.goto(`/bots/${botId}`);
    await expect(page.getByTestId("coding-skeleton")).toBeVisible();
    await expect(page.getByTestId("coding-error")).toBeVisible();
    fail = false;
    await page.getByTestId("coding-retry").click();
    await expect(page.getByTestId("coding-row")).toHaveCount(5);
  } finally {
    await page.request.delete(`/api/bots/${botId}`);
  }
});
