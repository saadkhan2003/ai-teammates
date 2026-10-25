import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const bot = "11111111-1111-4111-8111-111111111111";
const out = process.env.RADIUS_OUT || "/opt/cursor/artifacts/radius/after";

async function install(page: Page, theme: "light" | "dark") {
  await page.addInitScript((mode) => {
    localStorage.setItem("teammates-theme", mode);
  }, theme);
  await page.route("**/api/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/api/events")) {
      await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: ": connected\n\n" });
      return;
    }
    if (url.includes("/api/auth/me")) {
      await route.fulfill({ json: { username: "saad", displayName: "Muhammad Saad Khan", role: "owner", theme } });
      return;
    }
    if (url.includes("/artifacts") || url.includes("/routines") || url.includes("/files") || url.includes("/memories") || url.includes("/skills") || url.includes("/plugins")) {
      await route.fulfill({ json: [] });
      return;
    }
    if (url.includes("/workspace")) {
      await route.fulfill({
        json: {
          bot: { id: bot, name: "Ada", role: "Teammate", status: "idle", avatarColor: "#ff3045", instructions: "Helps with the product." },
          conversationId: bot,
          tasks: [],
          messages: [
            { id: "m1", role: "user", content: "Hello from the composer." },
            { id: "m2", role: "assistant", content: "Working on the rounding pass." },
          ],
          approvals: [],
          pages: [],
          holder: "agent",
          openrouterConnected: true,
          codingJobs: [],
        },
      });
      return;
    }
    if (url.includes("/api/bots")) {
      await route.fulfill({
        json: [
          { id: bot, name: "Ada", role: "Teammate", status: "idle", section: "Teammates" },
          { id: "22222222-2222-4222-8222-222222222222", name: "Nova", role: "Research", status: "idle", section: "Teammates" },
        ],
      });
      return;
    }
    await route.fulfill({ json: [] });
  });
}

async function shot(page: Page, name: string) {
  mkdirSync(out, { recursive: true });
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: false });
}

async function squareSurfaces(page: Page) {
  return page.evaluate(() => {
    const bad: string[] = [];
    const nodes = document.querySelectorAll("body *");
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.closest("[data-radius-allow]")) continue;
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width < 16 || rect.height < 16) continue;
      if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) continue;
      const radii = style.borderRadius.split(/ /).map((part) => Number.parseFloat(part) || 0);
      if (radii.some((value) => value > 0)) continue;
      const bg = style.backgroundColor;
      const filled = bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent";
      const sides = ["Top", "Right", "Bottom", "Left"].filter((side) => {
        const width = Number.parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`));
        const borderStyle = style.getPropertyValue(`border-${side.toLowerCase()}-style`);
        return width > 0 && borderStyle !== "none";
      });
      if (!filled && sides.length < 3) continue;
      if (rect.width >= window.innerWidth * 0.85 && rect.height >= window.innerHeight * 0.45) continue;
      const id = node.dataset.testid || node.getAttribute("aria-label") || "";
      const cls = (node.className || "").toString().slice(0, 80);
      bad.push(`${node.tagName}${id ? `#${id}` : ""} ${Math.round(rect.width)}x${Math.round(rect.height)} ${cls}`);
      if (bad.length >= 12) break;
    }
    return bad;
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`radius ${theme}`, async ({ page }) => {
    await install(page, theme);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/?theme=${theme}`);
    await expect(page).toHaveURL(new RegExp(`/bots/${bot}(?:\\?theme=${theme})?$`));
    await expect(page.getByTestId("composer-pill")).toBeVisible();
    await shot(page, `${theme}-home`);
    if (process.env.RADIUS_CHECK !== "0") expect(await squareSurfaces(page), "home").toEqual([]);
    await page.goto(`/bots/${bot}?theme=${theme}`);
    await expect(page.getByTestId("composer-pill")).toBeVisible();
    await page.getByTestId("bot-name-button").click();
    await expect(page.getByTestId("info-pane")).toBeVisible();
    await shot(page, `${theme}-chat`);
    await shot(page, `${theme}-panel`);
    if (process.env.RADIUS_CHECK !== "0") expect(await squareSurfaces(page), "chat").toEqual([]);
    await page.goto(`/settings?theme=${theme}`);
    await expect(page.getByTestId("settings-modal")).toBeVisible();
    await shot(page, `${theme}-settings`);
    if (process.env.RADIUS_CHECK !== "0") expect(await squareSurfaces(page), "settings").toEqual([]);
    await page.goto(`/?theme=${theme}`);
    await page.getByTestId("new-bot").click();
    await page.getByRole("menuitem", { name: /new teammate/i }).click();
    await expect(page.getByTestId("create-bot-form")).toBeVisible();
    await shot(page, `${theme}-dialog`);
    if (process.env.RADIUS_CHECK !== "0") expect(await squareSurfaces(page), "dialog").toEqual([]);
  });
}
