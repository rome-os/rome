import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const srcDir = fileURLToPath(new URL("./src", import.meta.url));
const rendererOutDir = fileURLToPath(new URL("../desktop/src/renderer", import.meta.url));

const ENTRY_TITLES: Record<string, string> = {
  onboarding: "Install Rome Desktop",
  settings: "Rome Settings",
  quitting: "Rome",
  pill: "Rome",
};

export default defineConfig({
  plugins: [pluginReact()],
  resolve: {
    alias: {
      "@": srcDir,
    },
  },
  source: {
    entry: {
      onboarding: resolve(srcDir, "entries/onboarding.tsx"),
      settings: resolve(srcDir, "entries/settings.tsx"),
      quitting: resolve(srcDir, "entries/quitting.tsx"),
      pill: resolve(srcDir, "entries/pill.tsx"),
    },
  },
  html: {
    template: "./index.html",
    scriptLoading: "module",
    title: ({ entryName }) => ENTRY_TITLES[entryName] ?? "Rome",
  },
  server: {
    port: 9000,
  },
  output: {
    target: "web",
    distPath: { root: rendererOutDir },
    cleanDistPath: true,
    assetPrefix: "./",
  },
});
