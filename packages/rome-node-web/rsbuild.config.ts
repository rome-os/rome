import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

export default defineConfig({
  plugins: [pluginReact()],
  source: {
    entry: {
      index: "./src/main.tsx",
    },
  },
  html: {
    template: "./index.html",
  },
  output: {
    distPath: {
      root: "dist/web",
    },
    cleanDistPath: true,
    sourceMap: {
      js: false,
      css: false,
    },
  },
  performance: {
    chunkSplit: {
      strategy: "all-in-one",
    },
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:4310",
      "/healthz": "http://127.0.0.1:4310",
    },
  },
});
