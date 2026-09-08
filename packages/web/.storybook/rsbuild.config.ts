import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [pluginReact()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../src", import.meta.url)),
      "@rome-os/ui$": fileURLToPath(new URL("../../ui/src/index.ts", import.meta.url)),
      "@rome-os/ui": fileURLToPath(new URL("../../ui/src", import.meta.url)),
      "@rome-os/rome-web-components$": fileURLToPath(
        new URL("../../web-content/src/index.tsx", import.meta.url),
      ),
      "@rome-os/rome-web-components/styles": fileURLToPath(
        new URL("../../web-content/styles.css", import.meta.url),
      ),
      "@rome-os/rome-web-components/styles.css": fileURLToPath(
        new URL("../../web-content/styles.css", import.meta.url),
      ),
      "@rome-os/rome-web-components": fileURLToPath(
        new URL("../../web-content/src", import.meta.url),
      ),
    },
  },
  tools: { rspack: { resolve: { extensionAlias: { ".js": [".ts", ".tsx", ".js"] } } } },
});
