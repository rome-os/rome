import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { defineConfig, type RsbuildPlugin } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";
import { buildThemeCss, DEFAULT_THEME_NAME, getThemeDefinitions } from "../web/src/lib/theme";

const packageDir = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(packageDir, "dist/web");
const generatedThemePath = resolve(packageDir, "src/generated-theme.css");
const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".svg", ".json"]);
// Guardrail so accidental heavy dependencies (recharts, zod, markdown, icon packs) fail CI immediately.
// Baseline with Overview + Computer use log (@rome-os/node-ui/activity) is ~136 KiB gzip.
const MAX_TOTAL_GZIP_BYTES = 150 * 1024;

function generateDefaultThemeCss(): void {
  const defaultTheme = getThemeDefinitions().find((theme) => theme.id === DEFAULT_THEME_NAME);
  if (!defaultTheme) {
    throw new Error(
      `Default theme "${DEFAULT_THEME_NAME}" not found in packages/web/src/lib/themes.ts`,
    );
  }
  const css = `/* Generated from packages/web/src/lib/themes.ts (${defaultTheme.id}). Do not edit by hand. */\n${buildThemeCss([defaultTheme])}\n`;
  let previous = "";
  try {
    previous = readFileSync(generatedThemePath, "utf8");
  } catch {
    // First generation.
  }
  if (previous !== css) {
    writeFileSync(generatedThemePath, css, "utf8");
  }
}

function walkFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkFiles(full));
    else if (entry.isFile() && !entry.name.endsWith(".gz")) results.push(full);
  }
  return results.sort();
}

function pluginDefaultTheme(): RsbuildPlugin {
  return {
    name: "rome-node-web:default-theme",
    setup(api) {
      api.onBeforeStartDevServer(() => {
        generateDefaultThemeCss();
      });
      api.onBeforeBuild(() => {
        generateDefaultThemeCss();
      });
    },
  };
}

function pluginPrecompressAndBudget(): RsbuildPlugin {
  return {
    name: "rome-node-web:precompress-and-budget",
    setup(api) {
      api.onAfterBuild(({ isFirstCompile }) => {
        if (!isFirstCompile) return;
        const files = walkFiles(distDir);
        let totalRaw = 0;
        let totalGzip = 0;

        for (const file of files) {
          const raw = readFileSync(file);
          const rawBytes = raw.byteLength;
          totalRaw += rawBytes;
          if (COMPRESSIBLE.has(extname(file).toLowerCase())) {
            const compressed = gzipSync(raw, { level: 9 });
            writeFileSync(`${file}.gz`, compressed);
            totalGzip += compressed.byteLength;
            console.log(
              `${relative(distDir, file).padEnd(42)} ${(rawBytes / 1024).toFixed(1).padStart(7)} KiB  (gzip ${(compressed.byteLength / 1024).toFixed(1).padStart(6)} KiB)`,
            );
          } else {
            totalGzip += statSync(file).size;
            console.log(
              `${relative(distDir, file).padEnd(42)} ${(rawBytes / 1024).toFixed(1).padStart(7)} KiB`,
            );
          }
        }

        console.log(
          `Total: ${(totalRaw / 1024).toFixed(1)} KiB raw, ${(totalGzip / 1024).toFixed(1)} KiB gzip (budget ${(MAX_TOTAL_GZIP_BYTES / 1024).toFixed(0)} KiB)`,
        );

        if (totalGzip > MAX_TOTAL_GZIP_BYTES) {
          throw new Error(
            `Bundle size budget exceeded: ${totalGzip} bytes > ${MAX_TOTAL_GZIP_BYTES} bytes.`,
          );
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [pluginReact(), pluginDefaultTheme(), pluginPrecompressAndBudget()],
  source: {
    entry: {
      index: "./src/main.tsx",
    },
  },
  html: {
    template: "./index.html",
    templateParameters: {
      defaultTheme: DEFAULT_THEME_NAME,
    },
    scriptLoading: "module",
  },
  output: {
    target: "web",
    distPath: {
      root: "dist/web",
    },
    cleanDistPath: true,
    sourceMap: {
      js: false,
      css: false,
    },
  },
  performance: {
    chunkSplit: {
      strategy: "all-in-one",
    },
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:4310",
      "/healthz": "http://127.0.0.1:4310",
    },
  },
});
