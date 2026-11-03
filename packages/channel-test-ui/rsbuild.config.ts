import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

// The browser UI. `pnpm channels:ui` builds it into dist/web for the local
// server in src/server.ts; `dev:web` serves it with hot reload and sends API
// calls to a server already running on its default port.
export default defineConfig({
  plugins: [pluginReact()],
  source: { entry: { index: "./web/main.tsx" } },
  html: { title: "Channel scenarios" },
  output: { distPath: { root: "dist/web" }, cleanDistPath: true },
  server: { proxy: { "/api": "http://127.0.0.1:3212" } },
});
