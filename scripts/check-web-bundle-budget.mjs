/**
 * Holds the dashboard's first-screen JavaScript to a size budget and keeps the
 * heavy libraries out of it. Run it on a finished `rsbuild build`:
 *
 *   node scripts/check-web-bundle-budget.mjs [packages/web/dist]
 *
 * "First screen" means the scripts `index.html` loads itself. Everything a
 * route pulls in later (the chat code, the markdown stack, the locale
 * bundles) is a separate async chunk and is not counted here.
 *
 * The forbidden-library check reads each chunk's source map, which `rsbuild
 * build` writes unless ROME_DOCKER_APP_CODE_MODE=compiled. A missing map fails
 * the run: a check that skips silently would pass for the wrong reason.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

/** Gzip bytes of the first-screen scripts together. Measured value plus about 10% headroom. */
export const FIRST_SCREEN_GZIP_BUDGET_BYTES = 280 * 1024;

/**
 * Packages that must stay out of the first screen. Each is large and only a
 * feature that opens on demand needs it, so one landing in an initial chunk
 * means a static import slipped past a lazy boundary.
 */
export const FORBIDDEN_PACKAGES = [
  "shiki",
  "@shikijs",
  "mermaid",
  "katex",
  "monaco-editor",
  "@monaco-editor",
  "@novnc/novnc",
];

const EXTERNAL_FONT_HOSTS = /fonts\.googleapis\.com|fonts\.gstatic\.com/;

/** The scripts `index.html` loads, as paths relative to the build root. */
export function firstScreenScripts(html) {
  const paths = [];
  for (const match of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)) {
    const src = match[1];
    // `/runtime-config.js` is a per-deployment stub, not part of the bundle.
    if (/^\/?static\/.+\.js$/.test(src)) paths.push(src.replace(/^\//, ""));
  }
  return paths;
}

/** The files the route-preload script asks for, or null when the page has none. */
export function routePreloadFiles(html) {
  const script = html.match(/<script[^>]*data-route-preload[^>]*>([\s\S]*?)<\/script>/);
  if (!script) return null;
  const lists = script[1].match(/\[("[^"\]]+",?)+\]/g) ?? [];
  return lists.flatMap((list) => JSON.parse(list)).map((file) => file.replace(/^\//, ""));
}

/** The package a source-map `sources` entry belongs to, or null for first-party code. */
export function packageOfSource(source) {
  const marker = "node_modules/";
  const at = source.lastIndexOf(marker);
  if (at === -1) return null;
  const [first, second] = source.slice(at + marker.length).split("/");
  return first.startsWith("@") ? `${first}/${second}` : first;
}

function isForbidden(packageName) {
  return FORBIDDEN_PACKAGES.some(
    (forbidden) => packageName === forbidden || packageName.startsWith(`${forbidden}/`),
  );
}

/**
 * Judges measured chunks. `chunks` is [{ file, rawBytes, gzipBytes, sources }]
 * with `sources` null for a chunk that has no source map.
 */
export function judge({ chunks, budgetBytes = FIRST_SCREEN_GZIP_BUDGET_BYTES }) {
  const problems = [];
  const totalGzip = chunks.reduce((sum, chunk) => sum + chunk.gzipBytes, 0);
  const totalRaw = chunks.reduce((sum, chunk) => sum + chunk.rawBytes, 0);
  if (chunks.length === 0) problems.push("index.html loads no scripts from /static/.");
  if (totalGzip > budgetBytes) {
    problems.push(
      `First-screen JS is ${kb(totalGzip)} KB gzip, over the ${kb(budgetBytes)} KB budget. ` +
        "Move the new code behind a lazy import, or raise FIRST_SCREEN_GZIP_BUDGET_BYTES with the reason.",
    );
  }
  for (const chunk of chunks) {
    if (chunk.sources === null) {
      problems.push(`${chunk.file} has no source map, so forbidden libraries cannot be checked.`);
      continue;
    }
    const found = new Set();
    for (const source of chunk.sources) {
      const name = packageOfSource(source);
      if (name && isForbidden(name)) found.add(name);
    }
    if (found.size > 0) {
      problems.push(
        `${chunk.file} bundles ${[...found].sort().join(", ")} into the first screen. ` +
          "Load it with a dynamic import() where it is first used.",
      );
    }
  }
  return { totalGzip, totalRaw, problems };
}

/** Problems with the HTML itself: third-party font hosts, and a preload list that names missing files. */
export function judgeHtml({ html, fileExists, firstScreen }) {
  const problems = [];
  if (EXTERNAL_FONT_HOSTS.test(html)) {
    problems.push(
      "index.html loads fonts from Google Fonts. Fonts are self-hosted (src/fonts.css).",
    );
  }
  const preload = routePreloadFiles(html);
  if (preload === null) {
    problems.push("index.html has no route-preload script (route-preload-plugin.ts did not run).");
  } else {
    for (const file of preload) {
      if (!fileExists(file))
        problems.push(`The route-preload list names ${file}, which is not in the build.`);
      if (firstScreen.includes(file))
        problems.push(`The route-preload list repeats first-screen chunk ${file}.`);
    }
  }
  return problems;
}

const kb = (bytes) => (bytes / 1024).toFixed(1);

function measure(dist, file) {
  const code = readFileSync(join(dist, file));
  const mapPath = join(dist, `${file}.map`);
  const sources = existsSync(mapPath) ? JSON.parse(readFileSync(mapPath, "utf8")).sources : null;
  return {
    file,
    rawBytes: code.length,
    gzipBytes: gzipSync(code, { level: 9 }).length,
    sources,
  };
}

export function run(dist) {
  const html = readFileSync(join(dist, "index.html"), "utf8");
  const scripts = firstScreenScripts(html);
  const chunks = scripts.map((file) => measure(dist, file));
  const result = judge({ chunks });
  const htmlProblems = judgeHtml({
    html,
    fileExists: (file) => existsSync(join(dist, file)),
    firstScreen: scripts,
  });
  return { chunks, ...result, problems: [...result.problems, ...htmlProblems] };
}

function main() {
  const dist = resolve(process.argv[2] ?? "packages/web/dist");
  if (!existsSync(join(dist, "index.html"))) {
    console.error(`No index.html in ${dist}. Run the web build first.`);
    process.exit(2);
  }
  const { chunks, totalGzip, totalRaw, problems } = run(dist);
  for (const chunk of chunks) {
    console.log(
      `${kb(chunk.gzipBytes).padStart(8)} KB gzip ${kb(chunk.rawBytes).padStart(8)} KB raw  ${chunk.file}`,
    );
  }
  console.log(
    `${kb(totalGzip).padStart(8)} KB gzip ${kb(totalRaw).padStart(8)} KB raw  first screen, ${chunks.length} chunks (budget ${kb(FIRST_SCREEN_GZIP_BUDGET_BYTES)} KB gzip)`,
  );
  if (problems.length > 0) {
    for (const problem of problems) console.error(`FAIL: ${problem}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
