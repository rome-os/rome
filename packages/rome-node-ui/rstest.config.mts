import { pluginReact } from "@rsbuild/plugin-react";
import { defineConfig } from "@rstest/core";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: rootDir,
  plugins: [pluginReact()],
  // Pin NODE_ENV so an inherited `production` from the calling shell can't
  // leak in. React's production build omits `act`, which breaks every
  // @testing-library render.
  env: { NODE_ENV: "test" },
  testEnvironment: {
    name: "jsdom",
    prebundle: "auto",
  },
  setupFiles: ["./src/test/setup.ts"],
  include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
});
