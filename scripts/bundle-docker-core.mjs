#!/usr/bin/env node
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Builds what Node runs from core in the compiled runtime: every entry point
// Node starts is bundled by esbuild, and nothing else lands in core/dist. tsc
// only type-checks. esbuild inlines workspace packages that export TypeScript
// source and resolves the `@/` alias, neither of which plain Node can do.
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Static files and trees copied into core/dist so the published runtime can find
// them. The app templates back `op: "create"`; the memory template seeds a fresh
// profile's memory/ dir on first boot (MEMORY.md, IDENTITY.md, relationship/,
// etc.). Keep in sync with getAppTemplateDir() in paths.ts and
// getMemoryTemplateDir() in profile-memory.ts.
//
// The WeChat send driver is read at runtime relative to `import.meta.url`, which
// is its own folder under tsx and dist/ in the image, so a compiled runtime finds
// it only if it is copied to the path below.
export const bundledAssets = [
  ["packages/app-template/template", "dist/app-template", "app template"],
  ["packages/app-template/workflow", "dist/app-template-workflow", "app template"],
  ["packages/core/memory.example", "dist/memory.example", "memory template"],
  [
    "packages/core/src/connections/kinds/wechat-user/wechat-user-send-driver.py",
    "dist/wechat-user-send-driver.py",
    "WeChat send driver",
  ],
];
const esbuildModuleCandidates = [
  resolve(projectRoot, "node_modules/esbuild/lib/main.js"),
  resolve(projectRoot, "packages/desktop/node_modules/esbuild/lib/main.js"),
];

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function findEsbuildModuleCandidates() {
  const pnpmDir = resolve(projectRoot, "node_modules/.pnpm");
  const pnpmCandidates = [];

  try {
    const entries = await readdir(pnpmDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith("esbuild@")) {
        pnpmCandidates.push(resolve(pnpmDir, entry.name, "node_modules/esbuild/lib/main.js"));
      }
    }
  } catch {
    // Fall back to the normal workspace symlink candidates.
  }

  return [...esbuildModuleCandidates, ...pnpmCandidates.sort().reverse()];
}

async function loadEsbuild() {
  for (const candidate of await findEsbuildModuleCandidates()) {
    if (!(await pathExists(candidate))) {
      continue;
    }

    try {
      return await import(pathToFileURL(candidate).href);
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error("Unable to load workspace esbuild dependency for Docker core bundling.");
}

export function dockerBundleOptions(format = "esm") {
  return {
    bundle: true,
    platform: "node",
    target: "node24",
    format,
    packages: "external",
    sourcemap: false,
    legalComments: "none",
    logLevel: "info",
    plugins: [
      {
        name: "bundle-api-types",
        setup(build) {
          // This private workspace package exports TypeScript source. Resolve it
          // from the original importer and inline it, including relative .js
          // imports that point to .ts files. Plain Node cannot do that mapping,
          // and the relocated Caddy script has no Core workspace dependencies.
          build.onResolve({ filter: /^@rome\/api-types(?:\/|$)/ }, ({ path, resolveDir }) => ({
            path: createRequire(resolve(resolveDir, "package.json")).resolve(path),
          }));
        },
      },
    ],
  };
}

/** Options for an ESM entry whose dynamic imports load their packages only when called. */
export function splitBundleOptions(entry, outdir, entryName = "index") {
  return {
    ...dockerBundleOptions("esm"),
    entryPoints: [entry],
    outdir,
    splitting: true,
    entryNames: entryName,
    chunkNames: "chunks/[name]-[hash]",
  };
}

export const entrypoints = [
  ["packages/core/src/index.ts", "packages/core/dist/index.js", "esm"],
  ["packages/core/src/db/migrate.ts", "packages/core/dist/db/migrate.js", "esm"],
  ["scripts/generate-caddyfile.ts", "dist/scripts/generate-caddyfile.js", "cjs"],
];

// Without splitting, esbuild hoists every external import to the top of the
// bundle, including those of dynamically imported modules. The daemon loads
// telemetry after it spawns Rome, and the action worker installs telemetry
// before it loads the runtime, so each bundle splits its later import into a
// chunk.
export const splitEntrypoints = [
  ["packages/core/src/instance/daemon/index.ts", "packages/core/dist/daemon", "index"],
  [
    "packages/core/src/app-host/worker-bootstrap.ts",
    "packages/core/dist/app-host",
    "worker-bootstrap",
  ],
];

async function main() {
  const { build } = await loadEsbuild();
  // Nothing from an earlier build may stay behind for Node to load.
  await rm(resolve(projectRoot, "packages/core/dist"), { recursive: true, force: true });

  await Promise.all([
    ...entrypoints.map(([entry, outfile, format]) =>
      build({
        ...dockerBundleOptions(format),
        entryPoints: [resolve(projectRoot, entry)],
        outfile: resolve(projectRoot, outfile),
      }),
    ),
    ...splitEntrypoints.map(([entry, outdir, entryName]) =>
      build(
        splitBundleOptions(resolve(projectRoot, entry), resolve(projectRoot, outdir), entryName),
      ),
    ),
  ]);

  for (const [srcRel, destRel, label] of bundledAssets) {
    const src = resolve(projectRoot, srcRel);
    const dest = resolve(projectRoot, "packages/core", destRel);
    if (!(await pathExists(src))) {
      throw new Error(`Expected ${label} at ${src} but it does not exist; aborting bundle.`);
    }
    await mkdir(dirname(dest), { recursive: true });
    await cp(src, dest, { recursive: true });
    console.log(`Copied ${label} → ${dest}`);
  }

  console.log(
    `Bundled core runtime entrypoints (${entrypoints.length + splitEntrypoints.length} files).`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
