import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const bot = "11111111-1111-4111-8111-111111111111";
const job = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const out = process.env.SPACING_OUT || "/opt/cursor/artifacts/spacing/after";

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
    if (url.includes("/usage") || url.includes("/quotas")) {
      await route.fulfill({ json: { modelCalls: 12, costUsd: 0.42, latencyMs: 800, bots: 2, maxBots: 8, secrets: 1, maxSecrets: 20, computers: 1, maxComputers: 2 } });
      return;
    }
    if (url.includes("/policy")) {
      await route.fulfill({ json: { classes: { read: "ALLOW", write: "ASK" }, modelAssist: false } });
      return;
    }
    if (url.includes("/health")) {
      await route.fulfill({ json: { postgres: true, computerIsolation: true, users: 1, computers: 1, stuckTasks: 0 } });
      return;
    }
    if (url.includes("/coding-jobs/")) {
      await route.fulfill({ json: { id: job, title: "Theme fixes", status: "finished", step: "", prNumber: 7, prUrl: "https://example.com/pull/7", branch: "cursor/grok-chat-ui", filesChanged: 4, additions: 20, deletions: 3 } });
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
          messages: [{ id: "m1", role: "user", content: "Hello from the composer." }],
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

for (const theme of ["light", "dark"] as const) {
  test(`spacing ${theme}`, async ({ page }) => {
    await install(page, theme);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/login?theme=${theme}`);
    await expect(page.getByTestId("login-card")).toBeVisible();
    await shot(page, `${theme}-login`);
    await page.goto(`/invite?theme=${theme}`);
    await expect(page.getByText("Accept an invitation")).toBeVisible();
    await shot(page, `${theme}-invite`);
    await page.goto(`/?theme=${theme}`);
    await expect(page.getByRole("heading", { name: "Teammates" })).toBeVisible();
    await shot(page, `${theme}-home`);
    await page.goto(`/bots/${bot}?theme=${theme}`);
    await expect(page.getByTestId("composer-pill")).toBeVisible();
    await shot(page, `${theme}-chat`);
    await page.getByTestId("bot-name-button").click();
    await page.getByTestId("info-pane-close").click();
    await page.getByRole("button", { name: "Settings" }).click().catch(() => undefined);
    await page.goto(`/settings?theme=${theme}`);
    await expect(page.getByTestId("settings-modal")).toBeVisible();
    await shot(page, `${theme}-settings`);
    await page.goto(`/settings/usage?theme=${theme}`);
    await expect(page.getByText("Credits", { exact: true })).toBeVisible();
    await shot(page, `${theme}-usage`);
    await page.goto(`/settings/policy?theme=${theme}`);
    await expect(page.getByTestId("settings-modal")).toBeVisible();
    await shot(page, `${theme}-policy`);
    await page.goto(`/settings/computer?theme=${theme}`);
    await expect(page.getByTestId("settings-computer")).toBeVisible();
    await shot(page, `${theme}-computer`);
    await page.goto(`/settings/plugins?theme=${theme}`);
    await expect(page.getByRole("heading", { name: "Plugins" })).toBeVisible();
    await shot(page, `${theme}-plugins`);
    await page.goto(`/settings/updates?theme=${theme}`);
    await expect(page.getByTestId("updates-card")).toBeVisible();
    await shot(page, `${theme}-updates`);
    await page.goto(`/settings/secrets?theme=${theme}`);
    await expect(page.getByTestId("settings-modal")).toBeVisible();
    await shot(page, `${theme}-secrets`);
    await page.goto(`/system?theme=${theme}`);
    await expect(page.getByTestId("admin-health")).toBeVisible();
    await shot(page, `${theme}-system`);
    await page.goto(`/bots/${bot}?theme=${theme}`);
    await expect(page.getByTestId("composer-pill")).toBeVisible();
    await page.getByTestId("bot-name-button").click();
    await page.getByTestId("bot-settings-gear").click();
    await expect(page.getByTestId("bot-settings")).toBeVisible();
    await shot(page, `${theme}-bot-settings`);
    await page.goto(`/bots/${bot}/jobs/${job}?theme=${theme}`);
    await expect(page.getByTestId("coding-job-page")).toBeVisible();
    await shot(page, `${theme}-job`);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/login?theme=${theme}`);
    await shot(page, `${theme}-login-mobile`);
    await page.setViewportSize({ width: 1024, height: 576 });
    await page.goto(`/bots/${bot}?theme=${theme}`);
    await expect(page.getByTestId("composer-pill")).toBeVisible();
    await shot(page, `${theme}-chat-1024`);
  });
}
