import { defineConfig, loadEnv } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";
import { pluginSvgr } from "@rsbuild/plugin-svgr";
import remarkGfm from "remark-gfm";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
const srcDir = fileURLToPath(new URL("./src", import.meta.url));
const internalApiPort = process.env.INTERNAL_API_PORT ?? "4141";
const internalApiTarget = `http://127.0.0.1:${internalApiPort}`;
const emitSourceMaps = process.env.ROME_DOCKER_APP_CODE_MODE !== "compiled";
const isDevelopment = process.env.NODE_ENV === "development";
const packageDir = fileURLToPath(new URL("./", import.meta.url));

// Mirror Vite's envPrefix semantics: only env vars matching these prefixes (or
// exact names) are inlined into the bundle. loadEnv reads .env from the
// monorepo root and produces both `process.env.X` and `import.meta.env.X`
// define entries so existing source code keeps working.
const { publicVars } = loadEnv({
  cwd: workspaceRoot,
  prefixes: ["VITE_", "NEXT_PUBLIC_", "ENABLE_ADVANCED_ONBOARDING_FLOW", "SHOW_GOOGLE_OAUTH"],
});

// Also load packages/web/.env (+ .env.local) so PANTHEON_HOST can live next
// to the web bundle config. .env is committed (whitelisted in .gitignore)
// as the shipping default; .env.local stays gitignored for per-developer
// overrides; CI / staging / prod can still export PANTHEON_HOST in the
// shell to override both.
loadEnv({ cwd: packageDir });

// Rome Cloud origin is baked into the bundle so the sidebar "Browse App Store"
// link is a direct external anchor (new-tab open, no runtime fetch). Fail
// the build early when PANTHEON_HOST is missing — there is no safe fallback.
const romeCloudOrigin = (() => {
  const host = process.env.PANTHEON_HOST?.trim().replace(/\/+$/, "");
  if (!host) {
    throw new Error(
      "rome-web build requires PANTHEON_HOST to be set " +
        "(e.g. PANTHEON_HOST=https://romeos.cc). Add it to " +
        "packages/web/.env, packages/web/.env.local, or export it in CI.",
    );
  }
  try {
    return new URL(host).origin;
  } catch {
    throw new Error(`rome-web build: PANTHEON_HOST is not a valid URL: ${host}`);
  }
})();

export default defineConfig({
  plugins: [pluginReact(), pluginSvgr()],
  resolve: {
    alias: {
      "@": srcDir,
    },
  },
  // MDX design docs (src/pages/dev/mdx/docs/*.mdx) compile to React components
  // so a design note can render the real primitives it is describing. The
  // loader emits plain JS against the automatic JSX runtime, so nothing
  // downstream has to transform it. Dev-only surface: the docs are reachable
  // from /dev, which drops out of production builds.
  tools: {
    htmlPlugin(config, { entryName }) {
      if (entryName === "desktop-vnc") {
        config.template = resolve(packageDir, "desktop-vnc.html");
      }
    },
    rspack: {
      module: {
        rules: [
          {
            test: /\.mdx$/,
            // remark-gfm buys the table syntax a design doc needs for its
            // rule/reason columns; plain MDX would render the pipes as text.
            use: [{ loader: "@mdx-js/loader", options: { remarkPlugins: [remarkGfm] } }],
          },
        ],
      },
    },
  },
  source: {
    entry: {
      index: resolve(srcDir, "main.tsx"),
      "desktop-vnc": resolve(srcDir, "desktop-vnc.ts"),
    },
    define: {
      ...publicVars,
      "import.meta.env.ROME_CLOUD_ORIGIN": JSON.stringify(romeCloudOrigin),
    },
  },
  html: {
    template: "./index.html",
    scriptLoading: "module",
  },
  server: {
    cors: { origin: true },
    port: Number(process.env.WEB_PORT ?? 3000),
    strictPort: true,
    proxy: {
      "/api": { target: internalApiTarget, changeOrigin: true },
      "/webhooks": { target: internalApiTarget, changeOrigin: true },
      "/app-assets": { target: internalApiTarget, changeOrigin: true },
      "/ws/terminal": { target: internalApiTarget, ws: true, changeOrigin: true },
      // Route /desktop-proxy through the backend. The backend's
      // desktopProxyRoutes forwards to noVNC using its own ROME_NOVNC_PORT;
      // a containerized dev server can't reach the host's noVNC directly.
      "/desktop-proxy": { target: internalApiTarget, changeOrigin: true, ws: true },
    },
  },
  output: {
    target: "web",
    distPath: { root: "dist" },
    sourceMap: {
      js: emitSourceMaps ? (isDevelopment ? "cheap-module-source-map" : "source-map") : false,
      css: emitSourceMaps && !isDevelopment,
    },
  },
});
