import { expect, test } from "@playwright/test";
import { login } from "./helpers";

async function createBot(page: import("@playwright/test").Page) {
  await login(page);
  const response = await page.request.post("/api/bots", { data: { name: `Library ${Date.now().toString().slice(-5)}` } });
  expect(response.ok()).toBeTruthy();
  return (await response.json() as { id: string }).id;
}

function item(id: number, name: string, kind = "text") {
  return { id: `00000000-0000-0000-0000-${String(id).padStart(12, "0")}`, name, kind, ext: "", mime: "text/plain", sizeBytes: 12, source: "upload", direction: "in", createdAt: new Date().toISOString(), thumbUrl: null, pinned: false };
}

test("library renders three groups, unknown type and per-group paging at phone and desktop widths", async ({ page }) => {
  const botId = await createBot(page);
  try {
    let release: (() => void) | undefined;
    await page.route(`**/api/bots/${botId}/library**`, async route => {
      const url = new URL(route.request().url());
      if (!url.searchParams.has("group")) {
        await new Promise<void>(resolve => { release = resolve; });
        return route.fulfill({ json: { pinned: [], groups: [
          { key: "today", label: "Today", total: 6, items: [item(1, "Photo.png", "image"), item(2, "organize_documents.gs", "unknown"), item(3, "three.txt"), item(4, "four.md", "markdown"), item(5, "five.pdf", "pdf")], nextCursor: "today-next" },
          { key: "week", label: "This week", total: 1, items: [item(6, "weekly.txt")], nextCursor: null },
          { key: "older", label: "Older", total: 1, items: [item(7, "older.txt")], nextCursor: null },
        ] } });
      }
      expect(url.searchParams.get("group")).toBe("today");
      return route.fulfill({ json: { pinned: [], groups: [{ key: "today", label: "Today", total: 6, items: [item(8, "six.txt")], nextCursor: null }] } });
    });
    await page.route(`**/api/bots/${botId}/library/*/content**`, route => route.fulfill({ status: 200, contentType: "text/plain", body: "preview text" }));
    await page.route(`**/api/bots/${botId}/library/*/pin`, route => route.fulfill({ status: 200, json: { ok: true, pinned: true } }));
    await page.route(`**/api/bots/${botId}/library/*`, route => route.request().method() === "DELETE" ? route.fulfill({ status: 200, json: { ok: true } }) : route.continue());
    await page.goto(`/bots/${botId}`);
    await page.getByRole("tab", { name: "Library" }).click();
    await expect(page.getByTestId("library-loading")).toBeVisible();
    release?.();
    await expect(page.getByText("Today", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("info-pane")).toBeVisible();
    await expect(page.getByText("This week", { exact: true })).toBeVisible();
    await expect(page.getByText("Older", { exact: true })).toBeVisible();
    await expect(page.getByTestId("library-unknown-icon")).toBeVisible();
    await page.getByRole("button", { name: "Photo.png" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog").getByRole("img", { name: "Photo.png" })).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("dialog")).toContainText("organize_documents.gs");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "three.txt" }).click();
    await expect(page.getByRole("dialog")).toContainText("preview text");
    await page.keyboard.press("Escape");
    const rowActions = page.getByRole("button", { name: "Actions for Photo.png" });
    await rowActions.focus();
    await expect(rowActions).toBeVisible();
    await rowActions.click();
    await page.getByRole("menuitem", { name: "Pin" }).click();
    await expect(page.getByRole("button", { name: "Download Photo.png" })).toBeAttached();
    await page.getByRole("button", { name: "Actions for Photo.png" }).click();
    await page.getByRole("menuitem", { name: "Delete…" }).click();
    await expect(page.getByRole("dialog")).toContainText("cannot be recovered after 30 days");
    await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Actions for Photo.png" }).click();
    await page.getByRole("menuitem", { name: "Delete…" }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "Show more" }).click();
    await expect(page.getByText("six.txt")).toBeVisible();
    await expect(page.getByRole("button", { name: "Show more" })).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.getByTestId("library-group-today")).toBeVisible();
    await page.getByRole("button", { name: "Photo.png" }).hover();
    await expect(page.getByRole("button", { name: "Actions for Photo.png" })).toBeVisible();
  } finally {
    await page.unroute(`**/api/bots/${botId}/library**`).catch(() => undefined);
    await page.request.delete(`/api/bots/${botId}`);
  }
});

test("library loading, empty and retryable error states", async ({ page }) => {
  const botId = await createBot(page);
  try {
    let fail = true;
    await page.route(`**/api/bots/${botId}/library**`, async route => {
      if (fail) return route.fulfill({ status: 500, json: { error: "failed" } });
      return route.fulfill({ json: { pinned: [], groups: [
        { key: "today", label: "Today", total: 0, items: [], nextCursor: null },
        { key: "week", label: "This week", total: 0, items: [], nextCursor: null },
        { key: "older", label: "Older", total: 0, items: [], nextCursor: null },
      ] } });
    });
    await page.goto(`/bots/${botId}`);
    await page.getByRole("tab", { name: "Library" }).click();
    await expect(page.getByTestId("library-error")).toBeVisible();
    fail = false;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByText("Nothing here yet")).toBeVisible();
    await expect(page.getByText("Files you send and files your teammate shares will show up here.")).toBeVisible();
  } finally {
    await page.unroute(`**/api/bots/${botId}/library**`).catch(() => undefined);
    await page.request.delete(`/api/bots/${botId}`);
  }
});
