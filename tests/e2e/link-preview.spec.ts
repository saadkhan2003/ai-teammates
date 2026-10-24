import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const bot = "11111111-1111-4111-8111-111111111111";
const job = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const dir = "/opt/cursor/artifacts/link-preview";
const title = "PR #7 follow-up: theme fixes + System theme + Assign work button";
const external = "https://cursor.com/agents/bc-a34805ab-19fd-5b59-913c-7cde9ebbae92";

async function installApi(page: Page, saved: { theme: string }) {
  await page.addInitScript(() => {
    const theme = new URLSearchParams(location.search).get("theme");
    if (theme === "light" || theme === "dark" || theme === "system") localStorage.setItem("teammates-theme", theme);
  });
  await page.route("**/api/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/api/events")) {
      await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: ": connected\n\n" });
      return;
    }
    if (url.includes("/api/auth/me")) {
      await route.fulfill({ json: { username: "saad", displayName: "Muhammad Saad Khan", role: "owner", theme: saved.theme } });
      return;
    }
    if (url.includes("/artifacts") || url.includes("/routines") || url.includes("/files") || url.includes("/memories") || url.includes("/skills")) {
      await route.fulfill({ json: [] });
      return;
    }
    if (url.includes("/workspace")) {
      await route.fulfill({
        json: {
          bot: { id: bot, name: "Ada", role: "Teammate", status: "idle", avatarColor: "#3366ff" },
          conversationId: bot,
          tasks: [],
          messages: [
            { id: "m-user", role: "user", content: "Where is the follow-up?" },
            {
              id: "m-bot",
              role: "assistant",
              content: `The job is [${title}](${external}) and the settings live at [Usage](/settings/usage).\n[[job:${job}]]`,
            },
          ],
          approvals: [],
          pages: [],
          holder: "agent",
          openrouterConnected: true,
          codingJobs: [{ id: job, title: "UI batch", status: "running", step: "Editing the composer", prNumber: null, prUrl: "", branch: "", filesChanged: 0, additions: 0, deletions: 0 }],
        },
      });
      return;
    }
    if (url.includes("/api/bots")) {
      await route.fulfill({ json: [{ id: bot, name: "Ada", role: "Teammate", status: "idle", section: "Teammates" }] });
      return;
    }
    await route.fulfill({ json: [] });
  });
}

test("link pills show a themed hover card and the bot toolbar", async ({ page }) => {
  mkdirSync(dir, { recursive: true });
  const saved = { theme: "light" };
  await installApi(page, saved);
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.goto(`/bots/${bot}?theme=light`);
  await expect(page.locator("html")).toHaveClass(/light/);
  const pill = page.getByRole("link", { name: title, exact: true });
  await expect(pill).toHaveAttribute("href", external);
  await expect(pill).toHaveAttribute("target", "_blank");
  const usage = page.getByRole("link", { name: "Usage", exact: true });
  await expect(usage).toHaveAttribute("href", "/settings/usage");
  await expect(usage).not.toHaveAttribute("target", "_blank");

  await pill.hover();
  const preview = page.getByTestId("link-preview").filter({ hasText: title });
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("cursor.com/agents/bc-a34805ab");
  const truncated = await preview.getByTestId("link-preview-url").evaluate((node) => node.scrollWidth > node.clientWidth + 1);
  expect(truncated).toBe(true);
  const box = await pill.boundingBox();
  const card = await preview.boundingBox();
  expect(box && card).toBeTruthy();
  expect(card!.y + card!.height).toBeLessThanOrEqual(box!.y + 8);
  const toolbar = page.locator("#message-m-bot").getByTestId("message-toolbar");
  await expect(toolbar).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "React" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Reply" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "More message actions" })).toBeVisible();
  const bubble = await page.getByTestId("message-item").filter({ hasText: title }).getByTestId("message-bubble").boundingBox();
  const tools = await toolbar.boundingBox();
  expect(bubble && tools).toBeTruthy();
  expect(tools!.x).toBeGreaterThan(bubble!.x + bubble!.width - 4);
  await page.screenshot({ path: `${dir}/light-link-preview.png` });
  await preview.screenshot({ path: `${dir}/light-link-card.png` });

  await page.getByTestId("job-mention").hover();
  const jobCard = page.getByTestId("link-preview").filter({ hasText: "UI batch" });
  await expect(jobCard).toBeVisible();
  await expect(jobCard).toContainText(`/bots/${bot}/jobs/${job}`);
  await page.getByTestId("job-mention").click();
  await expect(page.getByTestId("coding-job-detail")).toContainText("UI batch");
  await page.keyboard.press("Escape");

  await usage.click();
  await expect(page).toHaveURL(/\/settings\/usage/);

  saved.theme = "dark";
  await page.goto(`/bots/${bot}?theme=dark`);
  await expect(page.locator("html")).not.toHaveClass(/light/);
  await page.getByRole("link", { name: title, exact: true }).hover();
  const darkCard = page.getByTestId("link-preview").filter({ hasText: title });
  await expect(darkCard).toBeVisible();
  await expect(page.locator("#message-m-bot").getByTestId("message-toolbar")).toBeVisible();
  const darkBg = await darkCard.evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(darkBg).not.toBe("rgb(255, 255, 255)");
  await page.screenshot({ path: `${dir}/dark-link-preview.png` });
  await darkCard.screenshot({ path: `${dir}/dark-link-card.png` });
});
