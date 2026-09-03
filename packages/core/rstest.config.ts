import { defineConfig } from "@rstest/core";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const junitReport = process.env.RSTEST_JUNIT === "1";

export default defineConfig({
  root: rootDir,
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "src"),
    },
  },
  output: {
    // The package publishes extensionless ESM imports that Node cannot load
    // after Rstest externalizes it in the node environment.
    bundleDependencies: ["@opentelemetry/api"],
  },
  globals: true,
  testEnvironment: "node",
  include: [
    "src/**/*.test.ts",
    "../app-runtime-sdk/src/**/*.test.ts",
    // One level only. The suites under `cli/store/` and `runtime/` still import
    // `vitest` and use its `vi` globals, so they have never run under any
    // script. Migrating them to `@rstest/core` is its own change.
    "../app-web-sdk/src/cli/*.test.ts",
    "../../rome_apps/*/src/**/*.test.ts",
    "../../scripts/**/*.test.ts",
    "../../infra/**/*.test.ts",
  ],
  exclude: [
    "**/node_modules/**",
    "../**/node_modules/**",
    "../../**/node_modules/**",
    "**/dist/**",
    "../**/dist/**",
    "../../**/dist/**",
  ],
  coverage: {
    provider: "v8",
    include: [
      "src/**/*.ts",
      "../app-runtime-sdk/src/**/*.ts",
      "../app-web-sdk/src/**/*.ts",
      "../../rome_apps/*/*.ts",
      "../../rome_apps/*/scripts/**/*.ts",
      "../../rome_apps/*/src/**/*.ts",
    ],
    exclude: [
      "src/**/*.test.ts",
      "../app-runtime-sdk/src/**/*.test.ts",
      "../app-web-sdk/src/**/*.test.ts",
      "../../rome_apps/*/src/**/*.test.ts",
      "src/**/types.ts",
      "src/telemetry.ts",
      "src/index.ts",
    ],
    thresholds: {
      branches: 65,
      functions: 60,
      lines: 50,
    },
  },
  reporters: junitReport ? ["default", ["junit", { outputPath: "test-results.xml" }]] : ["default"],
  testTimeout: 10_000,
  hookTimeout: 10_000,
});
