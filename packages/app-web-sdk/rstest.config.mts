import { defineConfig } from "@rstest/core";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: rootDir,
  env: { NODE_ENV: "test" },
  testEnvironment: {
    name: "node",
    prebundle: "auto",
  },
  setupFiles: ["./src/test/setup.ts"],
  include: ["src/**/*.test.ts"],
});
