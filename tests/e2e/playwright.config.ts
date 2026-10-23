import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 1_200_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: process.env.BASE_URL ?? "http://127.0.0.1:18080",
    actionTimeout: 20_000,
    channel: "chrome",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    trace: "retain-on-failure",
  },
  workers: 1,
  projects: [
    { name: "desktop", testMatch: /(?:acceptance|security|links|vnc-lifecycle|computer-view|question-card|plugins|new-teammate-form|create-bot|about|account-menu|settings-modal|shortcuts|settings-computer|chat-polish|events|refresh-notice|library-share|chat-features|teach-task|bot-messaging|reply-ux|routines-section|coding-section|computer-card)\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
    {
      name: "iphone-13",
      testMatch: /mobile\.spec\.ts|question-card\.spec\.ts|plugins\.spec\.ts/,
      use: { ...devices["iPhone 13"], browserName: "chromium", defaultBrowserType: "chromium" },
    },
    {
      name: "pixel-7",
      testMatch: /mobile\.spec\.ts/,
      use: { ...devices["Pixel 7"], browserName: "chromium", defaultBrowserType: "chromium" },
    },
    {
      name: "android-360",
      testMatch: /mobile\.spec\.ts/,
      use: {
        viewport: { width: 360, height: 800 },
        deviceScaleFactor: 2.5,
        isMobile: true,
        hasTouch: true,
        browserName: "chromium",
        defaultBrowserType: "chromium",
        userAgent:
          "Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
      },
    },
  ],
  outputDir: "../../docs/evidence/playwright",
});
