import { defineConfig } from "@playwright/test";

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: "./desktop-vnc-e2e",
  testMatch: "desktop-vnc.spec.ts",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: 0,
  reporter: isCI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: "http://localhost:3200",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "pnpm build:kit && rsbuild dev --config desktop-vnc-e2e/rsbuild.config.ts",
    env: { WEB_PORT: "3200" },
    url: "http://localhost:3200",
    reuseExistingServer: !isCI,
    timeout: isCI ? 180_000 : 60_000,
  },
});
