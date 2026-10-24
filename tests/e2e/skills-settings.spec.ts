import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { login } from "./helpers";

const shotDir = "/workspace/shots-skills-v2";
async function screenshot(page: Page, screen: string, theme: "light" | "dark") {
  await page.screenshot({ path: `${shotDir}/01-${screen}-${theme}.png`, fullPage: false });
}
async function theme(page: Page, mode: "light" | "dark") {
  await page.evaluate((value) => {
    localStorage.setItem("teammates-theme", value);
    document.documentElement.classList.toggle("light", value === "light");
  }, mode);
  await page.reload();
  await expect(page.getByTestId("skills-settings")).toBeVisible();
}

test("owner manages the shared Skills library in both themes", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  const botResponse = await page.request.post("/api/bots", { data: { name: `Skills ${Date.now()}` } });
  expect(botResponse.ok()).toBeTruthy();
  const bot = await botResponse.json() as { id: string };
  const slug = `settings-skill-${randomUUID()}`;
  let skillId: string | undefined;
  try {
    const created = await page.request.post("/api/skill-library", { data: {
      name: slug,
      title: "Queue review",
      description: "Use when reviewing a queue.",
      body: "# Review the queue\n\n- Check totals\n- Note exceptions",
      files: { "examples/checklist.txt": "Open orders\nExceptions" },
    } });
    expect(created.ok()).toBeTruthy();
    skillId = (await created.json() as { id: string }).id;

    await page.goto("/settings/skills");
    await expect(page.getByTestId("skills-settings")).toBeVisible();
    await theme(page, "light");
    const row = page.getByTestId("skills-list").getByRole("button").filter({ hasText: slug });
    await expect(row).toBeVisible();
    await screenshot(page, "skills-list", "light");
    await row.click();
    await expect(page.getByTestId("skill-detail").getByText("Check totals")).toBeVisible();
    await expect(page.getByText("examples/checklist.txt")).toBeVisible();
    await screenshot(page, "skills-view", "light");
    await page.getByTestId("skill-edit").click();
    await expect(page.getByTestId("skill-editor")).toBeVisible();
    await screenshot(page, "skills-edit", "light");
    await page.getByTestId("skill-body").fill("# Review the queue\n\n- Check two queues\n- Note exceptions");
    await page.getByTestId("skill-save").click();
    await expect(page.getByTestId("skill-detail").getByText("Check two queues")).toBeVisible();
    await expect(page.getByTestId("skill-detail").getByText("Version 2")).toBeVisible();
    await expect(page.getByTestId("skill-detail").getByText("Version 1")).toBeVisible();
    await expect(page.getByTestId("skill-detail").getByText("Version 0")).toHaveCount(0);
    await page.getByTestId("skill-delete").click();
    await expect(page.getByTestId("skill-delete-dialog")).toBeVisible();
    await screenshot(page, "skills-delete-dialog", "light");

    await theme(page, "dark");
    const darkRow = page.getByTestId("skills-list").getByRole("button").filter({ hasText: slug });
    await screenshot(page, "skills-list", "dark");
    await darkRow.click();
    await screenshot(page, "skills-view", "dark");
    await page.getByTestId("skill-edit").click();
    await screenshot(page, "skills-edit", "dark");
    await page.getByRole("button", { name: "Cancel editing" }).click();
    await page.getByTestId("skill-delete").click();
    await screenshot(page, "skills-delete-dialog", "dark");
    await page.getByTestId("skill-confirm-delete").click();
    await expect(page.getByTestId("skills-list").getByText(slug)).toHaveCount(0);

    // The delete approval card is supplied from the same workspace shape used by the live API.
    const workspace = await page.request.get(`/api/bots/${bot.id}/workspace`).then(response => response.json());
    await page.route(`**/api/bots/${bot.id}/workspace`, route => route.fulfill({ json: {
      ...workspace,
      approvals: [{ id: "skill-approval", action: "delete_skill", target: slug, reason: "Delete this shared skill?", summary: "Delete skill “Queue review”", riskClass: "delete", status: "pending" }],
    } }));
    await page.goto(`/bots/${bot.id}`);
    await expect(page.getByTestId("approval-card")).toContainText("delete_skill");
    await screenshot(page, "skills-approval-card", "dark");
    await page.evaluate(() => { localStorage.setItem("teammates-theme", "light"); document.documentElement.classList.add("light"); });
    await page.reload();
    await expect(page.getByTestId("approval-card")).toContainText("delete_skill");
    await screenshot(page, "skills-approval-card", "light");
    await page.unrouteAll();
  } finally {
    if (skillId) await page.request.post(`/api/skill-library/${skillId}/archive`);
    await page.request.delete(`/api/bots/${bot.id}`);
  }
});
