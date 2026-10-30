import { build } from "esbuild";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { ensureBetterSqlite3Binding } from "./rebuild-native.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const sharedConfig = {
  bundle: true,
  platform: "node",
  target: "node20",
  sourcemap: false,
  minify: true,
  external: ["electron", "better-sqlite3", "koffi"],
};

ensureBetterSqlite3Binding();

await build({
  ...sharedConfig,
  entryPoints: [resolve(root, "src/main/index.ts")],
  outfile: resolve(root, "dist/main/index.js"),
  format: "cjs",
});

await build({
  bundle: true,
  platform: "node",
  target: "node20",
  sourcemap: false,
  minify: true,
  external: ["electron"],
  entryPoints: [resolve(root, "src/preload/index.ts")],
  outfile: resolve(root, "dist/preload/index.js"),
  format: "cjs",
});

console.log("Build complete.");
