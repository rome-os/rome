import { pluginReact } from "@rsbuild/plugin-react";
import { pluginSvgr } from "@rsbuild/plugin-svgr";
import { defineConfig } from "@rstest/core";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: rootDir,
  plugins: [pluginReact(), pluginSvgr()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  // Pin NODE_ENV so an inherited `production` from the calling shell can't
  // leak in. React's production build omits `act`, which breaks every
  // @testing-library render.
  env: { NODE_ENV: "test" },
  // Testing Library uses the global hooks to enable React's act warnings.
  globals: true,
  // Keep the fast logic suite on Node; component tests opt into jsdom through
  // a per-file `// @rstest-environment jsdom` docblock.
  testEnvironment: {
    name: "node",
    prebundle: "auto",
  },
  setupFiles: ["./src/test/setup.ts"],
  include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
});
