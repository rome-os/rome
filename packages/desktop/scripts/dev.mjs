import { context } from "esbuild";
import { spawn } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { ensureBetterSqlite3Binding } from "./rebuild-native.mjs";
import { loadWorkspaceEnv } from "./shared-env.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const require = createRequire(import.meta.url);
// The spawned Electron inherits these, so a dev stack URL or a staging Rome
// Cloud origin in the repo .env reaches the app.
loadWorkspaceEnv(root);

const sharedConfig = {
  bundle: true,
  platform: "node",
  target: "node20",
  sourcemap: false,
  minify: true,
  external: ["electron", "better-sqlite3"],
};

ensureBetterSqlite3Binding();

// Watch main process
const mainCtx = await context({
  ...sharedConfig,
  entryPoints: [resolve(root, "src/main/index.ts")],
  outfile: resolve(root, "dist/main/index.js"),
  format: "cjs",
});

// Watch preload
const preloadCtx = await context({
  ...sharedConfig,
  entryPoints: [resolve(root, "src/preload/index.ts")],
  outfile: resolve(root, "dist/preload/index.js"),
  format: "cjs",
  platform: "node",
});

// Initial build
await mainCtx.rebuild();
await preloadCtx.rebuild();
console.log("Initial build complete, starting Electron...");

// Start Electron
const electronCli = require.resolve("electron/cli.js");
const electronProcess = spawn(
  process.execPath,
  [electronCli, resolve(root, "dist/main/index.js")],
  {
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "development" },
  },
);

electronProcess.on("close", (code) => {
  mainCtx.dispose();
  preloadCtx.dispose();
  process.exit(code ?? 0);
});

// Watch for changes and rebuild (Electron must be restarted manually)
await mainCtx.watch();
await preloadCtx.watch();
console.log("Watching for changes...");
