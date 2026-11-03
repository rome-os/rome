import { defineConfig } from "@rsbuild/core";
import mockConfig from "./rsbuild.config";

export default defineConfig({
  ...mockConfig,
  source: {
    ...mockConfig.source,
    define: {
      ...mockConfig.source?.define,
      "import.meta.env.ROME_MOCK_STRICT_E2E": "true",
    },
  },
  server: {
    ...mockConfig.server,
    proxy: {},
  },
});
