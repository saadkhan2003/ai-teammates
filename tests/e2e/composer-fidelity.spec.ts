import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const bot = "11111111-1111-4111-8111-111111111111";
const dir = "/opt/cursor/artifacts/composer";

async function installApi(page: Page, saved: { theme: string; working: boolean }) {
  await page.addInitScript(() => {
    const theme = new URLSearchParams(location.search).get("theme");
    if (theme === "light" || theme === "dark" || theme === "system") localStorage.setItem("teammates-theme", theme);
  });
  await page.route("**/api/**", async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    if (url.includes("/api/events")) {
      await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: ": connected\n\n" });
      return;
    }
    if (url.includes("/api/auth/me")) {
      await route.fulfill({ json: { username: "saad", displayName: "Muhammad Saad Khan", role: "owner", theme: saved.theme } });
      return;
    }
    if (method === "PUT" && url.includes("/files")) {
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    if (url.includes("/artifacts") || url.includes("/routines") || url.includes("/files") || url.includes("/memories") || url.includes("/skills")) {
      await route.fulfill({ json: [] });
      return;
    }
    if (url.includes("/workspace")) {
      await route.fulfill({
        json: {
          bot: { id: bot, name: "Ada", role: "Teammate", status: "idle", avatarColor: "#ff3045" },
          conversationId: bot,
          tasks: saved.working ? [{ id: "t1", status: "running", title: "Reply" }] : [],
          messages: [{ id: "m-user", role: "user", content: "Where is the follow-up?" }],
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
      await route.fulfill({ json: [{ id: bot, name: "Ada", role: "Teammate", status: "idle", section: "Teammates" }] });
      return;
    }
    if (url.includes("/messages") && method === "POST") {
      await route.fulfill({ json: { ok: true } });
      return;
    }
    await route.fulfill({ json: [] });
  });
}

async function shot(page: Page, name: string) {
  mkdirSync(dir, { recursive: true });
  await page.getByTestId("composer-stack").screenshot({ path: `${dir}/${name}.png` });
}

test("composer matches the reference in light and dark", async ({ page }) => {
  const saved = { theme: "light", working: false };
  await installApi(page, saved);
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.goto(`/bots/${bot}?theme=light`);
  await expect(page.locator("html")).toHaveClass(/light/);
  const pill = page.getByTestId("composer-pill");
  await expect(page.getByTestId("composer")).toHaveAttribute("placeholder", "Message Ada");
  const box = await pill.boundingBox();
  expect(box?.height).toBeGreaterThan(38);
  expect(box?.height).toBeLessThan(48);
  const radius = await pill.evaluate((node) => Number.parseFloat(getComputedStyle(node).borderRadius));
  expect(radius).toBeGreaterThan(20);
  const lightBg = await pill.evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(lightBg).toBe("rgb(255, 255, 255)");
  await expect(page.getByTestId("composer-voice")).toBeVisible();
  await expect(page.getByTestId("send-chat")).toHaveCount(0);
  await expect(page.getByTestId("composer-add")).toBeVisible();
  await shot(page, "light-empty");

  await page.getByTestId("composer").fill("Hello");
  await expect(page.getByTestId("send-chat")).toBeVisible();
  await expect(page.getByTestId("composer-voice")).toHaveCount(0);
  await expect.poll(async () => page.getByTestId("send-chat").locator("svg").first().evaluate((node) => Number(getComputedStyle(node).opacity))).toBeLessThan(0.05);
  await shot(page, "light-typing");

  await page.getByTestId("composer").fill("One\nTwo\nThree\nFour");
  await expect(pill).toHaveAttribute("data-multiline", "true");
  const multiRadius = await pill.evaluate((node) => Number.parseFloat(getComputedStyle(node).borderRadius));
  expect(multiRadius).toBeGreaterThan(100);
  await shot(page, "light-multiline");

  await page.getByTestId("composer").fill("");
  await page.getByTestId("message-item").first().getByTestId("message-reply").click({ force: true });
  const chip = page.getByTestId("reply-chip");
  await expect(chip).toBeVisible();
  const chipBox = await chip.boundingBox();
  const pillBox = await pill.boundingBox();
  expect(chipBox && pillBox && chipBox.y + chipBox.height).toBeLessThanOrEqual(pillBox.y + 4);
  await shot(page, "light-reply");
  await chip.getByRole("button", { name: "Cancel reply" }).click();

  await page.locator('input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await expect(pill.getByTestId("upload-card")).toBeVisible();
  await shot(page, "light-attachment");

  saved.theme = "dark";
  saved.working = true;
  await page.goto(`/bots/${bot}?theme=dark`);
  await expect(page.locator("html")).not.toHaveClass(/light/);
  const darkBg = await page.getByTestId("composer-pill").evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(darkBg).not.toBe("rgb(255, 255, 255)");
  expect(darkBg).toBe("rgb(30, 30, 30)");
  await expect(page.getByTestId("avatar-status")).toContainText("Typing…");
  await shot(page, "dark-empty");
  await page.getByTestId("composer-presence").screenshot({ path: `${dir}/dark-typing-line.png` });
  await page.getByTestId("composer").fill("Hello from the dark composer");
  await shot(page, "dark-typing");
  await page.getByTestId("composer").fill("One\nTwo\nThree");
  await shot(page, "dark-multiline");
  await page.getByTestId("composer").fill("");
  await page.getByTestId("message-reply").click({ force: true });
  await shot(page, "dark-reply");
  await page.getByRole("button", { name: "Cancel reply" }).click();
  await page.locator('input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await shot(page, "dark-attachment");
});
