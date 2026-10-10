import { defineConfig, rspack } from "@rsbuild/core";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import baseConfig from "../rsbuild.config";

/**
 * Build config for mock mode — the full dashboard SPA served without a
 * backend. The entry starts an MSW service worker (fixtures in ./handlers)
 * before loading the real src/main.tsx, so fixture-backed /api calls are
 * answered in-browser.
 *
 * This is deliberately a SEPARATE entry point rather than a
 * dev branch in the SPA: `pnpm build` reads ../rsbuild.config.ts, whose single
 * entry is src/main.tsx, so neither MSW nor any fixture is ever bundled into
 * the dashboard.
 *
 * The base config supplies the shell and build settings. Ordinary mock mode
 * keeps its backend proxy for endpoint overrides. rsbuild.e2e.config.ts
 * disables that proxy for Midscene runs.
 *
 * Run: `pnpm --filter rome-web dev:mock` (http://localhost:3200).
 */
const mockDir = fileURLToPath(new URL("./", import.meta.url));

export default defineConfig({
  ...baseConfig,
  // The backend's mock fixtures require NODE_ENV=TEST, but this remains a
  // development review build. Keeping Rsbuild in development mode preserves
  // import.meta.env.DEV and therefore the /dev component-gallery routes.
  mode: "development",
  tools: {
    ...baseConfig.tools,
    rspack: {
      ...baseConfig.tools?.rspack,
      plugins: [
        new rspack.NormalModuleReplacementPlugin(/^\.\/pages\/AppsIndexPage$/, (resource) => {
          resource.request = resolve(mockDir, "TourAppsPage.tsx");
        }),
        new rspack.NormalModuleReplacementPlugin(
          /^@\/components\/chat\/ChatComposer$/,
          (resource) => {
            resource.request = resolve(mockDir, "TourChatComposer.tsx");
          },
        ),
        new rspack.NormalModuleReplacementPlugin(/^@\/hooks\/use-stick-to-bottom$/, (resource) => {
          resource.request = resolve(mockDir, "use-tour-scroll.ts");
        }),
        new rspack.NormalModuleReplacementPlugin(/use-free-cells$/, (resource) => {
          if (resource.context !== mockDir) {
            resource.request = resolve(mockDir, "use-tour-workspace.ts");
          }
        }),
      ],
    },
  },
  source: {
    ...baseConfig.source,
    entry: { index: resolve(mockDir, "main.tsx") },
    define: {
      ...baseConfig.source?.define,
      "import.meta.env.ROME_MOCK_STRICT_E2E": "false",
    },
  },
  server: {
    ...baseConfig.server,
    port: Number(process.env.MOCK_WEB_PORT ?? 3200),
    // Serve the package's real public/ assets plus mockServiceWorker.js,
    // which only exists in mock mode.
    publicDir: [{ name: "public" }, { name: "mock/public" }],
  },
  output: {
    ...baseConfig.output,
    distPath: { root: "dist-mock" },
  },
});
