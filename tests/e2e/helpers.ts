import { expect, type Page } from "@playwright/test";

export async function login(page: Page) {
  await page.goto("/");
  const shell = page.getByTestId("app-shell");
  const username = page.getByTestId("login-username");
  await expect(shell.or(username)).toBeVisible();
  if (await shell.isVisible()) return;
  await username.fill(process.env.OWNER_USERNAME ?? "saad");
  await page.getByTestId("login-password").fill(process.env.OWNER_PASSWORD ?? "teammates-dev");
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
