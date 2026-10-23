import { expect, test } from "@playwright/test";
import { login } from "./helpers";

const item = { id: "00000000-0000-0000-0000-000000000123", name: "report-results.pdf", kind: "pdf", ext: "pdf", mime: "application/pdf", sizeBytes: 64, source: "upload", direction: "in", createdAt: new Date().toISOString(), thumbUrl: null, pinned: false, dlpState: "clean" };

test("library search, filters, share menu and keyboard work at phone and desktop widths", async ({ page }) => {
  await login(page);
  const made = await page.request.post("/api/bots", { data: { name: `Library search ${Date.now().toString().slice(-5)}` } });
  expect(made.ok()).toBeTruthy();
  const botId = (await made.json() as { id: string }).id;
  const prefix = `**/api/bots/${botId}/library**`;
  const shares = `**/api/bots/${botId}/library/${item.id}/share`;
  try {
    await page.route(prefix, route => {
      const url = new URL(route.request().url());
      if (url.searchParams.has("q")) return route.fulfill({ json: { items: [item] } });
      return route.fulfill({ json: { pinned: [], groups: [
        { key: "today", label: "Today", total: 1, items: [item], nextCursor: null },
        { key: "week", label: "This week", total: 0, items: [], nextCursor: null },
        { key: "older", label: "Older", total: 0, items: [], nextCursor: null },
      ] } });
    });
    await page.route(shares, route => route.request().method() === "POST"
      ? route.fulfill({ json: { url: "http://127.0.0.1:18080/s/" + "a".repeat(64) } })
      : route.fulfill({ json: { shares: [{ id: "share-1", expiresAt: new Date(Date.now() + 86400000).toISOString(), revokedAt: null }] } }));
    await page.route(`${shares}/**`, route => route.fulfill({ json: { ok: true } }));
    await page.route("**/api/public/library/**", route => route.request().url().endsWith("/content")
      ? route.fulfill({ status: 200, contentType: "text/plain", body: "shared preview text" })
      : route.fulfill({ json: { name: item.name, kind: "text", mime: "text/plain", sizeBytes: 19, contentUrl: route.request().url() + "/content" } }));
    await page.goto(`/bots/${botId}`);
    await page.getByRole("tab", { name: "Library" }).click();

    for (const width of [360, 390, 1280]) {
      await page.setViewportSize({ width, height: 860 });
      const search = page.getByRole("textbox", { name: "Search library" });
      await page.keyboard.press("/");
      await expect(search).toBeFocused();
      await search.fill("report");
      await expect(page.getByRole("region", { name: "Search results" })).toBeVisible();
      await expect(page.getByText("pdf", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Screenshots" })).toBeVisible();
      await page.getByRole("button", { name: "Uploaded" }).click();
      await page.getByRole("button", { name: "report-results.pdf" }).focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.keyboard.press("Escape");
      const actions = page.getByRole("button", { name: "Actions for report-results.pdf" });
      await actions.focus();
      await actions.click();
      await page.getByRole("menuitem", { name: "Share" }).click();
      await page.getByRole("button", { name: "Actions for report-results.pdf" }).click();
      await expect(page.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
      await page.keyboard.press("Escape");
    }
    await page.goto(`/s/${"a".repeat(64)}`);
    await expect(page.getByRole("heading", { name: item.name })).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    await expect(page.locator("pre")).toContainText("shared preview text");
  } finally {
    await page.unroute(prefix).catch(() => undefined);
    await page.unroute(shares).catch(() => undefined);
    await page.request.delete(`/api/bots/${botId}`);
  }
});
