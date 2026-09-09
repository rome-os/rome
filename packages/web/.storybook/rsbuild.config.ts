import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";
import { fileURLToPath } from "node:url";
import { sourceAliases } from "./source-aliases.js";

export default defineConfig({
  plugins: [pluginReact()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../src", import.meta.url)),
      ...sourceAliases(new URL("../../ui/", import.meta.url)),
      ...sourceAliases(new URL("../../web-content/", import.meta.url)),
    },
  },
  tools: { rspack: { resolve: { extensionAlias: { ".js": [".ts", ".tsx", ".js"] } } } },
});
