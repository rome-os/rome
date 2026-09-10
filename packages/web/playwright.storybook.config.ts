import { defineConfig } from "@playwright/test";

const isCI = !!process.env.CI;
const port = Number(process.env.STORYBOOK_PORT ?? "6006");
const baseURL = process.env.STORYBOOK_BASE_URL ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./storybook-e2e",
  forbidOnly: isCI,
  reporter: isCI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: process.env.STORYBOOK_BASE_URL
    ? undefined
    : {
        command: `pnpm exec storybook dev --host 127.0.0.1 --port ${port} --exact-port --no-open`,
        url: baseURL,
        reuseExistingServer: !isCI,
        timeout: isCI ? 180_000 : 60_000,
      },
});
