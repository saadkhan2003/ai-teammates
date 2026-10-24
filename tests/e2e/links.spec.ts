import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

async function collect(page: Page, paths: Set<string>) {
  const hrefs = await page.locator("a[href]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href") || ""));
  for (const href of hrefs) {
    if (!href || href.startsWith("mailto:") || href.startsWith("javascript:")) continue;
    if (/^https?:\/\//.test(href)) continue;
    const path = href.split("#")[0].split("?")[0];
    if (!path.startsWith("/") || path.startsWith("/api/") || path.includes("logout")) continue;
    paths.add(path);
  }
}

test("every in-app link resolves", async ({ page }) => {
  await login(page);
  const paths = new Set<string>(["/", "/settings", "/settings/plugins", "/settings/computer", "/settings/secrets", "/settings/usage", "/settings/updates"]);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("sidebar").waitFor();
  await collect(page, paths);

  const bot = page.getByTestId("sidebar").locator('a[href^="/bots/"]').first();
  if ((await bot.count()) > 0) {
    await bot.click();
    await page.getByTestId("composer").waitFor();
    await collect(page, paths);
    const name = page.getByTestId("bot-name-button");
    if (!(await page.getByTestId("info-pane").isVisible().catch(() => false))) await name.click();
    await collect(page, paths);
  }

  await page.goto("/settings", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Settings", level: 1 }).waitFor();
  await collect(page, paths);

  const failures: string[] = [];
  for (const path of [...paths].sort()) {
    const response = await page.goto(path, { waitUntil: "domcontentloaded" });
    const status = response?.status() ?? 0;
    const text = await page.locator("body").innerText();
    if (status >= 400 || /this page could not be found/i.test(text)) failures.push(`${path} -> ${status}`);
  }
  expect(failures, failures.join("\n")).toEqual([]);
});
