import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// A dev checkout runs the TypeScript source under tsx. The compiled image
// ships no src/, so it runs the bundle scripts/bundle-docker-core.mjs builds.
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(packageRoot, "src/bin/list-required-apps.ts");

await import(
  pathToFileURL(existsSync(source) ? source : join(packageRoot, "dist/bin/list-required-apps.js"))
    .href
);
