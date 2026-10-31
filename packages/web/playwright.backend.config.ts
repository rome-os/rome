import { defineConfig } from "@playwright/test";

// The backend suite: the built dashboard, served by a real Rome daemon with
// fakes only at the model API and WeChat's iLink API. See backend-e2e/README.md.

const isCI = !!process.env.CI;
const romePort = Number(process.env.E2E_ROME_PORT ?? 4610);
const controlPort = Number(process.env.E2E_CONTROL_PORT ?? 4611);

export default defineConfig({
  testDir: "./backend-e2e",
  globalSetup: "./backend-e2e/global-setup.ts",
  // One Rome serves every test, and the WeChat connection is shared state, so
  // tests run one at a time. Each test names its chats with its own token.
  workers: 1,
  fullyParallel: false,
  forbidOnly: isCI,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 30_000 },
  reporter: isCI ? [["github"], ["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${romePort}`,
    storageState: "backend-e2e/.auth/guardian.json",
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    trace: "retain-on-failure",
    // E2E_SCREENSHOTS=on keeps a screenshot of every test, as evidence.
    screenshot: process.env.E2E_SCREENSHOTS === "on" ? "on" : "only-on-failure",
    launchOptions: process.env.E2E_CHROMIUM_PATH
      ? { executablePath: process.env.E2E_CHROMIUM_PATH }
      : undefined,
  },
  webServer: {
    // Run `pnpm build:apps` and `pnpm --filter rome-web build` first: Rome
    // serves packages/web/dist and installs the packed first-party apps.
    command: "pnpm --filter @rome/core exec tsx src/test/browser-e2e/server.ts",
    url: `http://127.0.0.1:${controlPort}/health`,
    reuseExistingServer: !isCI,
    // A first boot installs every first-party app's dependencies.
    timeout: 600_000,
    stdout: isCI ? "pipe" : "ignore",
    stderr: "pipe",
  },
});
