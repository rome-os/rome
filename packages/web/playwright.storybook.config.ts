import { defineConfig } from "@playwright/test";

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: "./storybook-e2e",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: 0,
  reporter: isCI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: "http://localhost:6026",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "pnpm storybook --port 6026 --ci",
    url: "http://localhost:6026",
    reuseExistingServer: !isCI,
    timeout: isCI ? 180_000 : 60_000,
  },
});
