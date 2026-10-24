import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /right-panel\.spec\.ts/,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:3310",
    channel: "chrome",
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
    video: "off",
  },
  webServer: {
    command: "npx next dev -p 3310",
    cwd: "/workspace/apps/web",
    url: "http://127.0.0.1:3310",
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
