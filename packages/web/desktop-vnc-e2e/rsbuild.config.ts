import { defineConfig } from "@rsbuild/core";
import { fileURLToPath } from "node:url";
import baseConfig from "../rsbuild.config";

const fakeRfbPath = fileURLToPath(new URL("./fake-rfb.ts", import.meta.url));

export default defineConfig({
  ...baseConfig,
  resolve: {
    ...baseConfig.resolve,
    alias: {
      "@novnc/novnc": fakeRfbPath,
      "@": fileURLToPath(new URL("../src", import.meta.url)),
    },
  },
});
