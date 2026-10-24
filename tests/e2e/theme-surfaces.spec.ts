import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const bot = "11111111-1111-4111-8111-111111111111";
const dir = "/opt/cursor/artifacts/theme";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function shot(page: Page, name: string) {
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${name}.png` });
}

async function installApi(page: Page, saved: { theme: string }) {
  const jobs = [
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "UI batch", status: "running", step: "Editing the composer", prNumber: null, prUrl: "", updatedAt: "2026-10-24T00:00:00Z" },
    {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      title: "API reactions",
      status: "finished",
      step: "",
      branch: "cursor/theme-surfaces",
      prNumber: 7,
      prUrl: "https://example.com/pull/7",
      filesChanged: 4,
      additions: 20,
      deletions: 3,
      updatedAt: "2026-10-24T00:00:01Z",
    },
  ];
  const messages = [
    {
      id: "m-bot",
      role: "assistant",
      content: "The composer follows the theme.",
      reactions: [{ id: "self", emoji: "😂", actorType: "bot" }],
    },
    {
      id: "m-question",
      role: "assistant",
      content: JSON.stringify({
        type: "question",
        prompt: "Which theme should the card use?",
        options: ["Light", "Dark"],
        answer: ["Dark"],
      }),
    },
    { id: "m-file", role: "assistant", content: "![clip](/clip.png)" },
    { id: "m-jobs", role: "assistant", content: '{"type":"coding-jobs"}' },
    {
      id: "m-user",
      role: "user",
      content: "Please keep every surface on the theme.",
      reactions: [{ id: "bot-like", emoji: "👍", actorType: "bot" }],
    },
  ];
  await page.addInitScript(() => {
    const theme = new URLSearchParams(location.search).get("theme");
    if (theme === "light" || theme === "dark" || theme === "system") localStorage.setItem("teammates-theme", theme);
  });
  await page.route("**/clip.png", (route) => route.fulfill({ status: 200, contentType: "image/png", body: png }));
  await page.route("**/api/**", async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    if (url.includes("/api/events")) {
      await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: ": connected\n\n" });
      return;
    }
    if (url.includes("/api/settings/appearance") && method === "PUT") {
      const body = route.request().postDataJSON() as { theme?: string };
      saved.theme = body.theme ?? saved.theme;
      await route.fulfill({ json: { theme: saved.theme } });
      return;
    }
    if (url.includes("/api/auth/me")) {
      await route.fulfill({ json: { username: "saad", role: "owner", theme: saved.theme } });
      return;
    }
    if (url.includes("/workspace")) {
      await route.fulfill({
        json: {
          bot: { id: bot, name: "Ada", role: "Teammate", avatarColor: "#3366ff" },
          conversationId: bot,
          tasks: [],
          messages,
          approvals: [],
          pages: [],
          holder: "agent",
          openrouterConnected: true,
          codingJobs: jobs,
        },
      });
      return;
    }
    if (url.includes("/computer/power")) {
      await route.fulfill({ json: { status: "hibernated" } });
      return;
    }
    if (url.includes("/api/bots")) {
      await route.fulfill({ json: [{ id: bot, name: "Ada", role: "Teammate" }] });
      return;
    }
    await route.fulfill({ json: [] });
  });
}

async function openChat(page: Page, mode: "light" | "dark" | "system", saved: { theme: string }) {
  saved.theme = mode;
  await page.goto(`/bots/${bot}?theme=${mode}`);
  await expect(page.getByTestId("composer-pill")).toBeVisible();
  await expect(page.getByTestId("coding-jobs-card")).toBeVisible();
  await expect(page.getByTestId("job-result-card")).toBeVisible();
  await expect(page.getByTestId("attachment-card")).toBeVisible();
  await expect(page.getByTestId("question-card")).toBeVisible();
  await expect(page.getByTestId("computer-asleep")).toBeVisible();
  await page.getByTestId("reaction-pill").hover();
  await expect(page.getByRole("tooltip", { name: "Ada reacted with 👍" })).toBeVisible();
}

test("chat surfaces follow light, dark, and both system schemes", async ({ page }) => {
  const saved = { theme: "system" };
  await installApi(page, saved);
  await page.setViewportSize({ width: 1440, height: 1100 });

  await page.emulateMedia({ colorScheme: "dark" });
  await openChat(page, "dark", saved);
  await expect(page.locator("html")).not.toHaveClass(/light/);
  await expect.poll(async () => page.getByTestId("composer-pill").evaluate((node) => getComputedStyle(node).backgroundColor)).not.toBe("rgb(255, 255, 255)");
  await shot(page, "dark-chat");

  await page.emulateMedia({ colorScheme: "light" });
  await openChat(page, "light", saved);
  await expect(page.locator("html")).toHaveClass(/light/);
  const lightComposer = await page.getByTestId("composer-pill").evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(lightComposer).not.toBe("rgb(20, 20, 20)");
  await shot(page, "light-chat");

  await page.emulateMedia({ colorScheme: "light" });
  await openChat(page, "system", saved);
  await expect(page.locator("html")).toHaveClass(/light/);
  await page.getByTestId("attachment-more").click();
  await expect(page.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
  await shot(page, "system-os-light");

  await page.keyboard.press("Escape");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).not.toHaveClass(/light/);
  await page.getByTestId("reaction-pill").hover();
  await expect(page.getByRole("tooltip", { name: "Ada reacted with 👍" })).toBeVisible();
  await shot(page, "system-os-dark");
  await shot(page, "reaction-pill");

  const user = page.getByTestId("message-item").filter({ hasText: "Please keep every surface" });
  await expect(user.locator('[data-testid="reaction-pill"][data-actor="bot"]')).toBeVisible();
  await expect(page.getByTestId("message-item").filter({ hasText: "The composer follows" }).locator('[data-testid="reaction-pill"]')).toHaveCount(0);
  const bubble = await user.getByTestId("message-bubble").boundingBox();
  const cluster = await user.getByTestId("reaction-cluster").boundingBox();
  expect(bubble && cluster).toBeTruthy();
  expect(cluster!.x + cluster!.width).toBeGreaterThan(bubble!.x + bubble!.width - 36);
  expect(Math.abs(cluster!.y + cluster!.height / 2 - (bubble!.y + bubble!.height))).toBeLessThan(14);
});

test("system mode switches live and settings save the choice", async ({ page }) => {
  const saved = { theme: "system" };
  await installApi(page, saved);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(`/bots/${bot}?theme=system`);
  await expect(page.locator("html")).not.toHaveClass(/light/);
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveClass(/light/);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).not.toHaveClass(/light/);

  await page.goto("/settings");
  await expect(page.getByTestId("theme-system")).toBeVisible();
  await page.getByTestId("theme-light").click();
  await expect.poll(() => saved.theme).toBe("light");
  await expect(page.locator("html")).toHaveClass(/light/);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/light/);
  await page.getByTestId("theme-dark").click();
  await expect.poll(() => saved.theme).toBe("dark");
  await expect(page.locator("html")).not.toHaveClass(/light/);
  await page.getByTestId("theme-system").click();
  await expect.poll(() => saved.theme).toBe("system");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveClass(/light/);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).not.toHaveClass(/light/);
});
