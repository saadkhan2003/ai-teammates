import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const dir = "/opt/cursor/artifacts/status-board";
const banned = /haiku|claude|anthropic|openrouter|\bgpt\b/i;

test.use({ baseURL: process.env.WEB_URL ?? "http://127.0.0.1:13010" });

function days(stateFor: (index: number) => string) {
  return Array.from({ length: 90 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 9, 24));
    date.setUTCDate(date.getUTCDate() - (89 - index));
    const state = stateFor(index);
    const uptimePercent = state === "nodata" ? null : state === "down" ? 0 : state === "degraded" ? 99.77 : 100;
    return { date: date.toISOString().slice(0, 10), state, uptimePercent, incidents: state === "down" ? 1 : 0 };
  });
}

const catalog = [
  ["api", "API", "The application API for sign-in, billing, and settings."],
  ["chat", "Chat/Realtime", "Live delivery of messages between you and your teammates."],
  ["computers", "Bot computers", "Computers teammates use for files and browsing."],
  ["agents", "Coding agents", "Workers that run coding jobs and routines."],
  ["integrations", "Integrations/Connectors", "Connected apps and remote plugins."],
  ["notifications", "Notifications", "System for sending notices to users."],
  ["storage", "Storage", "Database and workspace files."],
] as const;

function board(mode: "live" | "empty") {
  const series = mode === "empty" ? days(() => "nodata") : days((index) => (index === 70 ? "down" : index === 80 ? "degraded" : "up"));
  return {
    indicator: mode === "empty" ? "empty" : "none",
    description: mode === "empty" ? "No data yet" : "All systems operational",
    services: catalog.map(([id, name, description]) => ({ id, name, description, status: mode === "empty" ? "nodata" : "up", days: series })),
    incidents: mode === "empty" ? [] : [{ id: "inc-1", service: "API", title: "API is down", status: "resolved", startedAt: "2026-10-05T12:00:00.000Z", resolvedAt: "2026-10-05T13:00:00.000Z" }],
  };
}

async function install(page: Page, mode: "live" | "empty") {
  await page.addInitScript(() => {
    const theme = new URLSearchParams(location.search).get("theme");
    if (theme === "light" || theme === "dark" || theme === "system") localStorage.setItem("teammates-theme", theme);
  });
  await page.unroute("**/api/**").catch(() => undefined);
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/events") {
      await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: ": connected\n\n" });
      return;
    }
    const theme = new URL(page.url()).searchParams.get("theme") === "dark" ? "dark" : "light";
    if (path === "/api/auth/me") return json({ username: "saad", displayName: "Saad Khan", role: "owner", theme });
    if (path === "/api/status") return json(board(mode));
    return json([]);
  });
}

test("status board renders uptime in light and dark", async ({ page }) => {
  mkdirSync(dir, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    await install(page, "live");
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width: 1440, height: 1600 });
    await page.goto(`/account/status?theme=${theme}`);
    await expect(page.getByTestId("status-banner")).toContainText("All systems operational");
    await expect(page.getByTestId("service-api")).toContainText("Operational");
    await expect(page.getByTestId("service-api").getByTestId("uptime-bar")).toHaveCount(30);
    await expect(page.getByTestId("past-incidents")).toContainText("API is down");
    await expect(page.locator("body")).not.toContainText(banned);
    const footer = page.getByTestId("service-api").getByTestId("uptime-footer");
    await expect(footer).toContainText("30 days ago");
    await expect(footer).toContainText("Today");
    await expect(footer).toContainText("% uptime");
    await page.getByTestId("service-api").getByTestId("service-help").hover();
    await expect(page.getByTestId("service-api").getByRole("tooltip")).toContainText("sign-in, billing, and settings");
    const bars = page.getByTestId("service-notifications").getByTestId("uptime-bar");
    await bars.nth(20).hover();
    await expect(page.getByTestId("service-notifications").getByRole("tooltip").last()).toContainText("uptime");
    await page.getByTestId("uptime-board").screenshot({ path: `${dir}/${theme}.png` });
    await page.goto(`/status?theme=${theme}`);
    await expect(page.getByTestId("status-banner")).toContainText("All systems operational");
    await expect(page.locator("body")).not.toContainText(banned);
    if (theme === "light") await page.getByTestId("uptime-board").screenshot({ path: `${dir}/public-light.png` });
  }
  await page.setViewportSize({ width: 1680, height: 1400 });
  await page.goto("/account/status?theme=light");
  await expect(page.getByTestId("service-api").getByTestId("uptime-bar")).toHaveCount(90);
  await expect(page.getByTestId("service-api").getByTestId("uptime-footer")).toContainText("90 days ago");

  await install(page, "empty");
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.goto("/account/status?theme=light");
  await expect(page.getByTestId("status-banner")).toContainText("No data yet");
  await expect(page.getByTestId("status-banner")).not.toContainText("All systems operational");
  await expect(page.getByTestId("service-storage")).toContainText("No data");
  await expect(page.getByTestId("past-incidents")).toContainText("No incidents recorded.");
  await page.getByTestId("uptime-board").screenshot({ path: `${dir}/empty.png` });
});
