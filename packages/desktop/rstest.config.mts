import { defineConfig } from "@rstest/core";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: rootDir,
  testEnvironment: "node",
  // Loading the electron package downloads the Electron binary when it is
  // missing, even where a test mocks the module, and parallel test files
  // race on that download. No unit test launches Electron, so any path will do.
  env: { ELECTRON_OVERRIDE_DIST_PATH: rootDir },
  output: {
    // The package's ESM dependency uses extensionless internal imports that
    // Node cannot load when Rstest externalizes it in the node environment.
    bundleDependencies: ["@opentelemetry/api"],
  },
});
