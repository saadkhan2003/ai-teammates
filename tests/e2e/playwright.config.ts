import { defineConfig, devices } from "@playwright/test";
import "./containers";

for (const name of ["STACK", "BASE_URL"]) {
  if (!process.env[name]) throw new Error(`${name} is required to run e2e tests`);
}

export default defineConfig({
  grepInvert: process.env.PERF === "1" ? undefined : /@perf/,
  globalSetup: "./global-setup.ts",
  testDir: ".",
  timeout: 1_200_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: process.env.BASE_URL!,
    // Only ENABLE_TEST_HOOKS stacks honor this explicit login-limit opt-in.
    extraHTTPHeaders: { "X-Teammates-Test-Login": "true" },
    storageState: "./.auth/owner.json",
    actionTimeout: 20_000,
    channel: "chrome",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    trace: "retain-on-failure",
  },
  workers: 1,
  projects: [
    { name: "admin", testMatch: /admin-(?:app|ai-models|billing)\.spec\.ts/, use: { ...devices["Desktop Chrome"], baseURL: process.env.ADMIN_URL } },
    { name: "desktop", testMatch: /(?:skills-settings|account-pages|admin-console|button-contrast|chat-messages|chat-ui|checklist|composer-fidelity|connect-apps|footer-pill|image-gallery|library-hover|link-preview|radius-pass|right-panel|sidebar-shell|spacing-pass|status-board|surfaces|theme-surfaces|typography|ui-shots|ui-checklist|computer-jobs|usage-credits|speed-virtual|speed-phase[12]|perf-speed|acceptance|security|links|vnc-lifecycle|computer-view|question-card|memory-notes|approval-rules|plugins|new-teammate-form|create-bot|about|account-menu|settings-modal|shortcuts|settings-computer|chat-polish|events|refresh-notice|library-share|library-section|library-search|chat-features|teach-task|bot-messaging|reply-ux|routines-section|coding-section|computer-card|chat-pill|long-run-resume|skills-v2|learning|briefs|widgets)\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
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
