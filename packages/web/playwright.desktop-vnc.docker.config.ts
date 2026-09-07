import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./runtime-e2e",
  testMatch: "desktop-vnc-docker.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
