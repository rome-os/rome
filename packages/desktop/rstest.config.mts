import { defineConfig } from "@rstest/core";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: rootDir,
  testEnvironment: "node",
  output: {
    // The package's ESM dependency uses extensionless internal imports that
    // Node cannot load when Rstest externalizes it in the node environment.
    bundleDependencies: ["@opentelemetry/api"],
  },
});
