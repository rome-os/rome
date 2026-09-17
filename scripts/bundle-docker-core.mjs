#!/usr/bin/env node
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Static files and trees copied into core/dist so the published runtime can find
// them. The app templates back `op: "create"`; the memory template seeds a fresh
// profile's memory/ dir on first boot (MEMORY.md, IDENTITY.md, relationship/,
// etc.). Keep in sync with getAppTemplateDir() in paths.ts and
// getMemoryTemplateDir() in profile-memory.ts.
//
// The WeChat scripts are read at runtime relative to `import.meta.url`, which is
// src/channels/ under tsx and dist/ in the image, so a compiled runtime finds
// them only if they are copied to the paths below: helperPath() in
// channels/wechat-user.ts reads the reader helper, and stageCaptureDriver() in
// channels/wechat-user-keys.ts reads the launch driver and the key tool.
export const bundledAssets = [
  ["packages/app-template/template", "dist/app-template", "app template"],
  ["packages/app-template/workflow", "dist/app-template-workflow", "app template"],
  ["packages/core/memory.example", "dist/memory.example", "memory template"],
  [
    "packages/core/src/channels/wechat-user-helper.py",
    "dist/wechat-user-helper.py",
    "WeChat reader helper",
  ],
  [
    "packages/core/src/channels/wechat-user-launch-driver.py",
    "dist/wechat-user-launch-driver.py",
    "WeChat launch driver",
  ],
  [
    "packages/core/src/channels/vendor/wcdb_key_tool.py",
    "dist/vendor/wcdb_key_tool.py",
    "WeChat key tool",
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

const entrypoints = [
  ["packages/core/src/index.ts", "packages/core/dist/index.js", "esm"],
  ["packages/core/src/daemon/index.ts", "packages/core/dist/daemon/index.js", "esm"],
  ["packages/core/src/actions/worker.ts", "packages/core/dist/actions/worker.js", "esm"],
  ["scripts/generate-caddyfile.ts", "dist/scripts/generate-caddyfile.js", "cjs"],
];

async function main() {
  if (process.env.ROME_DOCKER_APP_CODE_MODE !== "compiled") {
    console.log("Skipping Docker runtime bundling; ROME_DOCKER_APP_CODE_MODE is not compiled.");
    return;
  }

  const { build } = await loadEsbuild();

  await Promise.all(
    entrypoints.map(([entry, outfile, format]) =>
      build({
        ...dockerBundleOptions(format),
        entryPoints: [resolve(projectRoot, entry)],
        outfile: resolve(projectRoot, outfile),
      }),
    ),
  );

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

  console.log(`Bundled Docker runtime entrypoints (${entrypoints.length} files).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
