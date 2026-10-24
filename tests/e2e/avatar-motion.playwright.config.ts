import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /avatar-motion\.spec\.ts/,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: "/opt/cursor/artifacts/playwright-avatar",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4179",
    viewport: { width: 1100, height: 800 },
    deviceScaleFactor: 2,
    video: "on",
    screenshot: "off",
  },
  webServer: {
    command: "npm run dev -- --port 4179 --hostname 127.0.0.1",
    cwd: "../../apps/web",
    url: "http://127.0.0.1:4179/dev/avatar-motion",
    reuseExistingServer: true,
    timeout: 120_000,
    env: { NEXT_TELEMETRY_DISABLED: "1" },
  },
});
