import { mkdir } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { autoAllowBrowserOpens, login } from "./helpers";

test.use({ viewport: { width: 1440, height: 900 } });
const shots = "/workspace/shots-pages-v1";
async function screenshot(page: Page, name: string, theme: string) {
  await mkdir(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/${name}-${theme}.png`, fullPage: false });
}
async function themePage(page: Page, theme: string) {
  await page.addInitScript(mode => localStorage.setItem("teammates-theme", mode), theme);
}

for (const theme of ["light", "dark"]) {
  test(`Pages canvas flow with mock chat, grid, calculator, history and sharing (${theme})`, async ({ page, browser }) => {
    await themePage(page, theme); await login(page);
    const response = await page.request.post("/api/bots", { data: { name: `Pages ${theme} ${Date.now()}` } });
    expect(response.ok()).toBeTruthy();
    const bot = await response.json() as { id: string };
    const stopAllow = autoAllowBrowserOpens(page, bot.id, ["write_page", "edit_page"]);
    try {
      await page.goto(`/bots/${bot.id}`);
      const botName = page.getByTestId("bot-name-button");
      if (await botName.getAttribute("aria-expanded") !== "true") await botName.click();
      await page.getByRole("tab", { name: "Library", exact: true }).click();
      await expect(page.getByText("Nothing here yet", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Pages", exact: true }).click();
      await expect(page.getByTestId("pages-library")).toBeVisible();
      await page.getByRole("button", { name: /All library items/ }).click();
      const appText = await page.locator("body").innerText();
      expect(appText).not.toMatch(/OpenRouter|OpenAI|Anthropic|GPT|Claude|Gemini|DeepInfra/i);
      await page.getByTestId("composer").fill("Make a page with projects and a calculator");
      await page.getByTestId("send-chat").click();
      const card = page.getByTestId("page-card").first();
      await expect(card).toContainText("Quarterly overview", { timeout: 180000 });
      await screenshot(page, "01-chat-card", theme);
      await card.getByRole("button", { name: "Open", exact: true }).click();
      const canvas = page.getByTestId("page-canvas");
      await expect(canvas).toBeVisible();
      const frame = page.frameLocator('[data-testid="page-frame"]');
      await expect(frame.getByRole("heading", { name: "Quarterly overview", exact: true })).toBeVisible();
      await frame.getByRole("button", { name: "Project" }).click();
      await expect(frame.getByRole("columnheader", { name: /Project/ })).toHaveAttribute("aria-sort", "ascending");
      await expect(frame.locator("tbody tr").first()).toContainText("Atlas");
      await frame.getByPlaceholder("Filter rows").fill("Planning");
      await expect(frame.locator("tbody tr")).toHaveCount(1);
      await expect(frame.locator("tbody tr")).toContainText("Beacon");
      await frame.getByPlaceholder("Filter rows").fill("");
      await frame.getByLabel("Price", { exact: true }).fill("50");
      await frame.getByLabel("Quantity", { exact: true }).fill("4");
      await expect(frame.getByLabel("Total", { exact: true })).toHaveText("200");
      const separator = canvas.getByRole("separator", { name: "Resize page canvas" });
      const before = await separator.getAttribute("aria-valuenow");
      await separator.focus(); await page.keyboard.press("ArrowLeft");
      expect(await separator.getAttribute("aria-valuenow")).not.toBe(before);
      await screenshot(page, "02-side-panel", theme);
      await canvas.getByRole("button", { name: "Full screen page", exact: true }).click();
      await expect(canvas.getByRole("button", { name: "Exit full screen" })).toBeVisible();
      await screenshot(page, "08-full-screen", theme);
      await canvas.getByRole("button", { name: "Exit full screen" }).click();
      await page.getByTestId("composer").fill("Update the page");
      await page.getByTestId("send-chat").click();
      await expect(canvas).toContainText("Version 2", { timeout: 180000 });
      const list = await page.request.get(`/api/bots/${bot.id}/pages`).then(r => r.json()) as Array<{ id: string; current_version: number }>;
      expect(list).toHaveLength(1); expect(list[0].current_version).toBe(2);
      await canvas.getByRole("button", { name: "Version history", exact: true }).click();
      const history = page.getByTestId("page-history");
      await expect(history).toContainText("Updated the quarterly heading");
      await screenshot(page, "04-history", theme);
      await history.getByRole("button", { name: /Version 1/ }).click();
      await expect(frame.getByRole("heading", { name: "Quarterly overview", exact: true })).toBeVisible();
      await screenshot(page, "09-old-version", theme);
      await canvas.getByRole("button", { name: "Restore version", exact: true }).click();
      await expect(canvas).toContainText("Version 3");
      await expect(history).toContainText("Restored version 1");
      await canvas.getByRole("button", { name: "Share page", exact: true }).click();
      const dialog = page.getByTestId("page-share-dialog");
      await dialog.getByRole("button", { name: "Create read-only link" }).click();
      const url = await dialog.getByLabel("Page share link").inputValue();
      expect(url).toContain("/p/");
      await screenshot(page, "05-share-dialog", theme);
      const anonymous = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: { cookies: [], origins: [] } });
      try {
        const shared = await anonymous.newPage(); await themePage(shared, theme); await shared.goto(url);
        await expect(shared.getByTestId("shared-page")).toContainText("Read-only · v3");
        await expect(shared.frameLocator('[data-testid="page-frame"]').getByRole("heading", { name: "Quarterly overview", exact: true })).toBeVisible();
        await screenshot(shared, "06-shared-view", theme);
        await expect(shared.getByRole("button", { name: /Restore version|Share page|Create read-only link/ })).toHaveCount(0);
        const revoked = page.waitForResponse(response => response.request().method() === "DELETE" && /\/api\/pages\/[^/]+\/shares\//.test(response.url()));
        await dialog.getByRole("button", { name: "Revoke", exact: true }).click();
        expect((await revoked).ok()).toBeTruthy();
        await shared.reload(); await expect(shared.getByTestId("page-unavailable")).toContainText("isn’t available");
      } finally { await anonymous.close(); }
      await page.keyboard.press("Escape");
      const downloadEvent = page.waitForEvent("download");
      await canvas.getByRole("button", { name: "Export", exact: true }).click();
      expect((await downloadEvent).suggestedFilename()).toMatch(/\.md$/);
      await canvas.getByRole("button", { name: "Close page", exact: true }).click();
      const name = page.getByTestId("bot-name-button");
      if (await name.getAttribute("aria-expanded") !== "true") await name.click();
      await page.getByRole("tab", { name: "Library", exact: true }).click();
      await page.getByRole("button", { name: "Pages", exact: true }).click();
      const library = page.getByTestId("pages-library");
      await expect(library).toContainText("Quarterly overview");
      await library.getByLabel("Search pages").fill("does not exist");
      await expect(library).toContainText("No matching pages");
      await library.getByLabel("Search pages").fill("Quarterly");
      await library.getByLabel("Page kind").selectOption("dashboard");
      await expect(library).toContainText("Quarterly overview");
      await screenshot(page, "03-library-list", theme);
      await library.getByRole("button", { name: /Quarterly overview/ }).click();
      await expect(page.getByTestId("page-canvas")).toBeVisible();
    } finally { stopAllow(); await page.request.delete(`/api/bots/${bot.id}`); }
  });
}
