import { expect, test } from "@playwright/test";
test("chat composer exposes file attach and teach task actions accessibly", async ({ page }) => {
  await page.goto("/login");
  await page.getByTestId("login-username").fill(process.env.OWNER_USERNAME ?? "saad");
  await page.getByTestId("login-password").fill(process.env.OWNER_PASSWORD ?? "teammates-dev");
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("app-shell")).toBeVisible();
  const response = await page.request.get("/api/bots");
  expect(response.ok()).toBeTruthy();
  const bots = await response.json();
  const bot = Array.isArray(bots) ? bots[0] : bots?.bots?.[0];
  expect(bot?.id).toBeTruthy();

  await page.evaluate(id => localStorage.setItem("teammates-last-bot", id), bot.id);
  await page.goto("/");
  await expect(page).toHaveURL(new RegExp(`/bots/${bot.id}$`));
  await page.goto(`/bots/${bot.id}`);
  const composer = page.getByTestId("composer");
  await expect(composer).toBeVisible();
  await expect(composer).toHaveAttribute("aria-label", `Message ${bot.name}`);
  const scroll = page.getByTestId("chat-scroll");
  await scroll.hover();
  await expect(scroll).toHaveCSS("scrollbar-color", /rgb\(/);
  const headerPill = page.getByTestId("bot-name-button");
  await headerPill.hover();
  await expect(headerPill).toHaveCSS("transition-property", /background-color/);

  await page.getByTestId("composer-plus").click();
  await expect(page.getByTestId("plus-attach")).toBeVisible();
  await expect(page.getByTestId("plus-teach-task")).toBeVisible();
});
