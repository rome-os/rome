import { defineConfig } from "@rsbuild/core";
import mockConfig from "./rsbuild.config";

export default defineConfig({
  ...mockConfig,
  mode: "production",
  output: {
    ...mockConfig.output,
    sourceMap: false,
  },
});
