import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test("chat empty state, missing-key banner, Markdown, composer shortcuts and collapsed approvals", async ({ page }) => {
  await login(page);
  const bot = "11111111-1111-4111-8111-111111111111";
  let messages: object[] = [];
  await page.route(`**/api/bots/${bot}/**`, route => route.fulfill({ json: [] }));
  await page.route("**/api/system/llm-status", route => route.fulfill({ json: { hasKey: false } }));
  await page.route(`**/api/bots/${bot}/workspace`, route => route.fulfill({ json: {
    bot: { id: bot, name: "Polish", role: "Teammate" }, conversationId: bot,
    tasks: [], messages, approvals: [{ id: "decided", action: "browser_open", target: "https://example.com", status: "approved" }], pages: [], holder: "agent", openrouterConnected: false,
  } }));
  await page.route(`**/api/conversations/${bot}/messages`, async route => {
    const data = route.request().postDataJSON();
    messages = [{ id: "one", role: "user", content: data.content }, { id: "two", role: "assistant", content: "**Hello** [Example](https://example.com) `safe` [Unsafe](javascript:alert(1)) <script>alert(1)</script>" }];
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto(`/bots/${bot}`);
  await expect(page.getByTestId("chat-empty")).toBeVisible();
  await expect(page.getByTestId("llm-key-banner")).toBeVisible();
  await expect(page.getByTestId("approval-card")).toContainText("Allowed browser_open example.com");
  await expect(page.getByTestId("approve-once")).toHaveCount(0);
  const composer = page.getByTestId("composer");
  await composer.fill("First line");
  await composer.press("Shift+Enter");
  await composer.press("a");
  await expect(composer).toHaveValue("First line\na");
  await composer.press("Enter");
  await expect(page.getByTestId("message-item").filter({ has: page.locator("strong") })).toContainText("Hello");
  await expect(page.getByRole("link", { name: "Example", exact: true })).toHaveAttribute("href", "https://example.com");
  await expect(page.getByRole("link", { name: "Unsafe", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("message-item").locator("script")).toHaveCount(0);
  await composer.focus();
  await composer.press("Escape");
  await expect(composer).not.toBeFocused();
});
