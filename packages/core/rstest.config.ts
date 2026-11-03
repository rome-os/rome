import { defineConfig } from "@rstest/core";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const junitReport = process.env.RSTEST_JUNIT === "1";
// Channel scenario traces for packages/channel-test-ui, written only on request.
const channelTraces = process.env.ROME_CHANNEL_TRACES;
const channelTraceReporter = channelTraces
  ? new (await import("./src/test/kit/im/trace-reporter.js")).ChannelTraceReporter(
      path.resolve(channelTraces),
    )
  : undefined;

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
    "../channel-test-ui/src/**/*.test.ts",
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
      "../../rome_apps/*/*.ts",
      "../../rome_apps/*/scripts/**/*.ts",
      "../../rome_apps/*/src/**/*.ts",
    ],
    exclude: [
      "src/**/*.test.ts",
      "../app-runtime-sdk/src/**/*.test.ts",
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
  reporters: [
    "default",
    ...(junitReport ? [["junit", { outputPath: "test-results.xml" }] as const] : []),
    ...(channelTraceReporter ? [channelTraceReporter] : []),
  ],
  testTimeout: 10_000,
  hookTimeout: 10_000,
});
