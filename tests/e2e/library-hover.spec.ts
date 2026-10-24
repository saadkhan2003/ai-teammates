import { expect, test, type Page } from "@playwright/test";

const bot = "11111111-1111-4111-8111-111111111111";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function install(page: Page) {
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const older = "2026-10-09T00:32:00.000Z";
  await page.addInitScript(() => localStorage.setItem("teammates-theme", "dark"));
  await page.route("**/api/**", async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    if (url.includes("/api/events")) {
      await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: ": connected\n\n" });
      return;
    }
    if (url.includes("/files/raw")) {
      await route.fulfill({ status: 200, contentType: "image/png", body: png });
      return;
    }
    if (url.includes("/api/auth/me")) {
      await route.fulfill({ json: { username: "saad", displayName: "Muhammad Saad Khan", role: "owner", theme: "dark" } });
      return;
    }
    if (url.includes("/api/plugins")) {
      await route.fulfill({ json: [] });
      return;
    }
    if (url.includes("/files") && method === "GET") {
      await route.fulfill({
        json: [
          { path: "ours-chat-now.png", name: "ours-chat-now.png", updatedAt: hourAgo },
          { path: "organize_documents.gs", name: "organize_documents.gs", updatedAt: older },
        ],
      });
      return;
    }
    if (url.includes("/artifacts") || url.includes("/routines") || url.includes("/memories") || url.includes("/skills")) {
      await route.fulfill({ json: [] });
      return;
    }
    if (url.includes("/workspace")) {
      await route.fulfill({
        json: {
          bot: { id: bot, name: "Ada", role: "Personal Chief of Staff", avatarShape: "blob6", avatarColor: "#ff3045" },
          conversationId: bot,
          tasks: [],
          messages: [
            { id: "empty", role: "assistant", content: "   " },
            { id: "user", role: "user", content: "Working on the rounding pass." },
          ],
          approvals: [],
          pages: [{ targetId: "page-1", url: "https://example.com/notes", title: "Q4 notes" }],
          holder: "agent",
          openrouterConnected: true,
          codingJobs: [],
          llmProvider: "mock",
        },
      });
      return;
    }
    if (url.includes("/api/bots")) {
      await route.fulfill({ json: [{ id: bot, name: "Ada", role: "Personal Chief of Staff", avatarShape: "blob6", avatarColor: "#ff3045" }] });
      return;
    }
    await route.fulfill({ json: {} });
  });
}

test("library hover cards, dividers, and no empty bubbles", async ({ page }) => {
  await install(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/bots/${bot}?theme=dark`);
  const pane = page.getByTestId("info-pane");
  await expect(page.getByTestId("bot-name-button")).toBeVisible();
  if (!(await pane.isVisible().catch(() => false))) await page.getByTestId("bot-name-button").click();
  if (!(await pane.isVisible().catch(() => false))) await page.getByTestId("bot-name-button").click();
  await expect(pane).toBeVisible();

  const sidebarBorder = await page.getByTestId("sidebar").evaluate((node) => getComputedStyle(node).borderRightWidth);
  const panelBorder = await pane.evaluate((node) => getComputedStyle(node).borderLeftWidth);
  expect(sidebarBorder).toBe("1px");
  expect(panelBorder).toBe("1px");

  const bubbles = page.getByTestId("message-bubble");
  await expect(bubbles).toHaveCount(1);
  await expect(bubbles).toContainText("Working on the rounding pass.");
  const userBg = await bubbles.evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(userBg).toBe("rgb(255, 48, 69)");

  await pane.getByRole("tab", { name: "Library", exact: true }).click();
  const image = page.getByTestId("library-row").filter({ hasText: "ours-chat-now.png" });
  const file = page.getByTestId("library-row").filter({ hasText: "organize_documents.gs" });
  await expect(image).toBeVisible();
  await expect(image.getByTestId("library-age")).toHaveText("1h");
  await expect(page.getByRole("button", { name: "Show more" })).toHaveCount(0);
  await expect(page.getByText("Today", { exact: true })).toBeVisible();
  await expect(page.getByText("Older", { exact: true })).toBeVisible();

  await image.hover();
  await page.waitForTimeout(150);
  await expect(page.getByTestId("library-preview")).toHaveCount(0);
  await page.waitForTimeout(250);
  const card = page.getByTestId("library-preview");
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-kind", "image");
  await expect(card.getByTestId("library-preview-image")).toBeVisible();
  await expect(card).toContainText("Image");
  await expect(card).toContainText("ours-chat-now.png");
  await expect(card.getByTestId("library-preview-meta")).toContainText("Ada");
  await expect(card.getByTestId("library-preview-meta")).toContainText("Today");
  const paneBox = await pane.boundingBox();
  const cardBox = await card.boundingBox();
  expect(cardBox!.x).toBeGreaterThanOrEqual((paneBox!.x ?? 0) - 1);
  expect(cardBox!.x + cardBox!.width).toBeLessThanOrEqual((paneBox!.x ?? 0) + (paneBox!.width ?? 0) + 1);

  await file.hover();
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-kind", "file");
  await expect(card.getByTestId("library-preview-image")).toHaveCount(0);
  await expect(card).toContainText("File");
  await expect(card).toContainText("organize_documents.gs");
  await expect(card.getByTestId("library-preview-meta")).toContainText("Oct 9");

  await page.mouse.move(8, 8);
  await expect(card).toBeHidden();

  await file.focus();
  await expect(page.getByTestId("library-preview")).toBeVisible();
  await expect(page.getByTestId("library-preview")).toHaveAttribute("data-kind", "file");

  const pageRow = page.getByTestId("library-row").filter({ hasText: "Q4 notes" });
  await pageRow.hover();
  await page.waitForTimeout(400);
  await expect(page.getByTestId("library-preview")).toContainText("Page");
});
