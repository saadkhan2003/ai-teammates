import { expect, type Page } from "@playwright/test";

export async function login(page: Page) {
  await page.goto("/");
  const shell = page.getByTestId("app-shell");
  const username = page.getByTestId("login-username");
  await expect(shell.or(username)).toBeVisible();
  if (await shell.isVisible()) return;
  const user = process.env.OWNER_USERNAME ?? "saad";
  const pass = process.env.OWNER_PASSWORD ?? "teammates-dev";
  const password = page.getByTestId("login-password");
  // The login page is server-rendered; a fill before hydration is wiped by React and an empty username is
  // submitted. Wait for the page to settle and re-fill until both values stick before submitting.
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await expect(async () => {
    await username.fill(user);
    await password.fill(pass);
    await expect(username).toHaveValue(user, { timeout: 500 });
    await expect(password).toHaveValue(pass, { timeout: 500 });
  }).toPass({ timeout: 15_000 });
  await page.getByTestId("login-submit").click();
  await expect(shell).toBeVisible();
}

// v0.4 asks for Allow once whenever a run opens a new browser origin. Long
// acceptance specs that are not about that card allow it in the background.
export function autoAllowBrowserOpens(page: Page, botId: string, actions: string[] = ["browser_open"]) {
  let stopped = false;
  void (async () => {
    while (!stopped) {
      try {
        const response = await page.request.get(`/api/bots/${botId}/workspace`);
        if (response.ok()) {
          const workspace = await response.json();
          for (const item of workspace.approvals ?? []) {
            if (actions.includes(item.action) && item.status === "pending") {
              await page.request.post(`/api/approvals/${item.id}/decide`, { data: { decision: "allow_once" } });
            }
          }
        }
      } catch { /* page closed */ }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  })();
  return () => { stopped = true; };
}

/** Creates a disposable bot through the same API used by the create dialog. Caller cleans up the id. */
export async function createBot(page: Page, name: string, role = "test"): Promise<{ id: string; name: string }> {
  const response = await page.request.post("/api/bots", { data: { name, role } });
  expect(response.ok(), `create bot: HTTP ${response.status()}`).toBeTruthy();
  const bot = await response.json();
  expect(typeof bot.id).toBe("string");
  return bot;
}
