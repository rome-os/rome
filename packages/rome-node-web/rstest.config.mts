import { pluginReact } from "@rsbuild/plugin-react";
import { defineConfig } from "@rstest/core";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: rootDir,
  plugins: [pluginReact()],
  env: { NODE_ENV: "test" },
  testEnvironment: {
    name: "jsdom",
    prebundle: "auto",
  },
  setupFiles: ["./src/test/setup.ts"],
  include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
});
