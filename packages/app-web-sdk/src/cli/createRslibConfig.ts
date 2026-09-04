import { copyFileSync, existsSync, globSync, mkdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadConfig, mergeRslibConfig, type LibConfig, type RslibConfig } from "@rslib/core";
import { pluginReact } from "@rsbuild/plugin-react";
import tailwindPostcss from "@tailwindcss/postcss";
import { generateEntry } from "./generateEntry.js";
import { loadAppYaml, type LoadedAppYaml } from "./loadAppYaml.js";
import { RomeAppManifestPlugin } from "./manifestPlugin.js";

export interface BuildContextOptions {
  cwd: string;
  mode: "development" | "production";
}

export interface BuildContext {
  cwd: string;
  appDir: string;
  srcDir: string;
  outDir: string;
  /**
   * Top-level dirs under `src/` excluding `web/`. Used by build.ts/dev.ts to
   * pre-clean output trees before re-emitting — the backend lib writes
   * `outDir/<rel-path-from-src>` for every .ts(x) outside `web/`, so the set
   * of top-level subtrees we need to wipe is exactly this list.
   */
  backendDirs: readonly string[];
  loaded: LoadedAppYaml;
  rslibConfig: RslibConfig;
}

/** `src/` subdirs reserved for the web lib; the backend lib must not touch them. */
const WEB_DIR = "web";

export async function createBuildContext(options: BuildContextOptions): Promise<BuildContext> {
  const cwd = resolve(options.cwd);
  const loaded = loadAppYaml(cwd);
  const { appDir, yaml } = loaded;

  if (!yaml.appRoot) {
    throw new Error(
      `rome: ${appDir}/app.yaml must declare "appRoot" (e.g. \`appRoot: dist\`) so build outputs land where the runtime expects them.`,
    );
  }

  const srcDir = join(appDir, "src");
  const outDir = join(appDir, yaml.appRoot);

  if (!existsSync(srcDir)) {
    throw new Error(
      `rome: source directory ${srcDir} not found. With the new layout, all sources live under <appRoot>/src/.`,
    );
  }

  const webSrcDir = join(srcDir, "web");
  const webOutDir = join(outDir, "web");

  const userEntryRelative = yaml.web.entry ?? "App.tsx";
  const userEntryPath = resolve(webSrcDir, userEntryRelative);
  if (!existsSync(userEntryPath)) {
    throw new Error(
      `rome: web entry not found at ${userEntryPath} (set web.entry in app.yaml or create src/web/App.tsx)`,
    );
  }

  const generatedEntry = join(appDir, "node_modules", ".rome", "main.tsx");
  generateEntry({ outFile: generatedEntry, userEntryPath });

  const tsconfigPath = existsSync(join(webSrcDir, "tsconfig.json"))
    ? join(webSrcDir, "tsconfig.json")
    : existsSync(join(appDir, "tsconfig.json"))
      ? join(appDir, "tsconfig.json")
      : undefined;

  const backendDirs = globSync("*", {
    cwd: srcDir,
    withFileTypes: true,
    exclude: [WEB_DIR],
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const webLib: LibConfig = {
    format: "esm",
    bundle: true,
    source: {
      entry: { index: generatedEntry },
    },
    output: {
      autoExternal: false,
      minify: true,
      externals: "",
      emitCss: true,
      target: "web",
      distPath: {
        root: webOutDir,
      },
      cleanDistPath: true,
      sourceMap: {
        js: "source-map",
        css: true,
      },
    },
    plugins: [pluginReact()],
    tools: {
      postcss: (_config: unknown, utils: { addPlugins: (plugins: unknown[]) => void }) => {
        utils.addPlugins([tailwindPostcss()]);
      },
      rspack: {
        plugins: [
          new RomeAppManifestPlugin({
            displayName: yaml.web.displayName,
            navLabel: yaml.web.navLabel,
          }),
        ],
      },
    },
  };

  const lib: LibConfig[] = [webLib];

  // Only compile a backend lib when there are actual TS sources outside
  // `web/`. An app whose backend artifacts are pure assets (e.g. only agent
  // yamls or skill markdown) would otherwise hand rslib an entry glob that
  // matches nothing, which fails the whole build with no output — the assets
  // themselves are shipped by copyBackendAssets, not the backend lib.
  const hasBackendSources =
    globSync("**/*.{ts,tsx}", {
      cwd: srcDir,
      exclude: [
        `${WEB_DIR}/**`,
        "**/*.d.ts",
        "**/*.test.ts",
        "**/*.test.tsx",
        "**/*.integration.test.ts",
        "**/*.integration.test.tsx",
        "**/*.e2e.test.ts",
        "**/*.e2e.test.tsx",
      ],
    }).length > 0;
  if (backendDirs.length > 0 && hasBackendSources) {
    lib.push(createBackendLib({ srcDir, outDir }));
  }

  const baseConfig: RslibConfig = {
    root: appDir,
    source: {
      tsconfigPath,
      define: {
        "process.env.NODE_ENV": JSON.stringify(
          options.mode === "development" ? "development" : "production",
        ),
      },
    },
    lib,
  };

  const userConfig = await loadUserConfig(appDir);
  const rslibConfig: RslibConfig = userConfig
    ? (mergeRslibConfig(baseConfig, userConfig) as RslibConfig)
    : baseConfig;

  return { cwd, appDir, srcDir, outDir, backendDirs, loaded, rslibConfig };
}

function createBackendLib(args: { srcDir: string; outDir: string }): LibConfig {
  const { srcDir, outDir } = args;

  return {
    format: "esm",
    bundle: false,
    syntax: "esnext",
    outBase: srcDir,
    source: {
      entry: {
        index: [
          "./src/**/*.ts",
          "./src/**/*.tsx",
          `!./src/${WEB_DIR}/**`,
          "!./src/**/*.d.ts",
          "!./src/**/*.test.ts",
          "!./src/**/*.test.tsx",
          "!./src/**/*.integration.test.ts",
          "!./src/**/*.integration.test.tsx",
          "!./src/**/*.e2e.test.ts",
          "!./src/**/*.e2e.test.tsx",
        ],
      },
    },
    output: {
      autoExternal: true,
      target: "node",
      distPath: { root: outDir },
      // Don't wipe outDir — the web lib also writes here (web/).
      // build.ts/dev.ts pre-clean the per-backend-dir trees instead.
      cleanDistPath: false,
      sourceMap: {
        js: "source-map",
      },
    },
  };
}

/**
 * Mirror non-source asset files from `src/` into `outDir/`, preserving
 * directory structure. rslib emits .js for every .ts(x) under the backend
 * lib; everything else the author put in `src/` (yaml/json/sql/md/png/svg/
 * …) is shipped as-is so the runtime can find manifests, migrations, icons,
 * docs, prompt templates, etc. alongside the compiled code. The `web/`
 * subtree is owned by the web lib and skipped here.
 */
export function copyBackendAssets(args: { srcDir: string; outDir: string }): void {
  const { srcDir, outDir } = args;
  if (!existsSync(srcDir)) return;
  const matches = globSync("**/*", {
    cwd: srcDir,
    exclude: [`${WEB_DIR}/**`, "**/*.ts", "**/*.tsx", "**/*.d.ts", "**/*.css"],
  });
  for (const rel of matches) {
    const srcPath = join(srcDir, rel);
    if (!statSync(srcPath).isFile()) continue;
    const destPath = join(outDir, rel);
    mkdirSync(dirname(destPath), { recursive: true });
    copyFileSync(srcPath, destPath);
  }
}

export function copyAppIconAsset(args: {
  appDir: string;
  outDir: string;
  iconPath: string | undefined;
}): void {
  const { appDir, outDir, iconPath } = args;
  if (!iconPath) return;

  const sourcePath = resolveWithin(appDir, iconPath, "icon");
  if (!existsSync(sourcePath)) return;

  const targetPath = resolveWithin(outDir, iconPath, "icon output");
  if (sourcePath === targetPath) return;

  mkdirSync(dirname(targetPath), { recursive: true });
  copyFileSync(sourcePath, targetPath);
}

function resolveWithin(baseDir: string, path: string, label: string): string {
  if (isAbsolute(path)) {
    throw new Error(`rome: ${label} path must be relative: ${path}`);
  }

  const base = resolve(baseDir);
  const resolved = resolve(base, path);
  const rel = relative(base, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`rome: ${label} path escapes app directory: ${path}`);
  }
  return resolved;
}

async function loadUserConfig(cwd: string): Promise<RslibConfig | null> {
  const candidates = ["rslib.config.ts", "rslib.config.js", "rslib.config.mjs"];
  for (const name of candidates) {
    const candidatePath = join(cwd, name);
    if (!existsSync(candidatePath)) continue;
    const result = await loadConfig({ cwd, path: candidatePath });
    return (result.content ?? null) as RslibConfig | null;
  }
  return null;
}
