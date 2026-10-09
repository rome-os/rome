#!/usr/bin/env node
// Frontend performance bench for rome-web. Builds the dashboard, measures what
// the first load of /chat ships, then loads the static mock build in headless
// Chromium under fixed throttling and reports page-load timings. Each run is
// compared against a saved baseline so a change can be scored before it lands.
// Usage and metric definitions: docs/frontend-perf.md.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = join(webDir, "perf", ".results");
const defaultBaseline = join(resultsDir, "baseline.json");

const { values: args } = parseArgs({
  options: {
    "skip-build": { type: "boolean", default: false },
    "bundle-only": { type: "boolean", default: false },
    runs: { type: "string", default: "5" },
    "cpu-throttle": { type: "string", default: "4" },
    baseline: { type: "string" },
    "save-baseline": { type: "boolean", default: false },
    out: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (args.help) {
  console.log(`pnpm perf:web [options]

  --skip-build       Reuse dist/ and dist-mock/ from the last build
  --bundle-only      Measure the bundle and skip the browser runs
  --runs <n>         Browser runs per scenario, median reported (default 5)
  --cpu-throttle <n> Chromium CPU slowdown factor (default 4)
  --baseline <file>  Compare against this result (default perf/.results/baseline.json)
  --save-baseline    Also write this result as the new baseline
  --out <file>       Where to write the result (default perf/.results/latest.json)`);
  process.exit(0);
}

// Fixed so a baseline and a candidate run on the same machine see the same
// conditions. The network profile is roughly a home broadband connection: the
// bundle's transfer size shows up in load timings without dominating them.
const NETWORK = { latencyMs: 40, downloadKbps: 10_000 };
const RUNS = Number(args.runs);
const CPU_THROTTLE = Number(args["cpu-throttle"]);
if (!Number.isInteger(RUNS) || RUNS < 1) {
  throw new Error(`--runs must be a positive integer, got ${args.runs}`);
}
if (!Number.isFinite(CPU_THROTTLE) || CPU_THROTTLE < 1) {
  throw new Error(`--cpu-throttle must be a number >= 1, got ${args["cpu-throttle"]}`);
}
// A bundle-only result has no page-load section, so saving it as the baseline
// would silently drop the page-load numbers every later run compares against.
if (args["bundle-only"] && args["save-baseline"]) {
  throw new Error("--save-baseline needs the page-load runs, so drop --bundle-only");
}

const SCENARIOS = [
  { name: "chat-empty", path: "/chat", ready: "[data-chat-composer-box] textarea" },
  {
    name: "chat-transcript",
    path: "/chat/mock-chat-market-brief",
    ready: "[data-timeline-anchor]",
  },
];

function run(cmd, cmdArgs, env = {}) {
  console.error(`$ ${cmd} ${cmdArgs.join(" ")}`);
  const result = spawnSync(cmd, cmdArgs, {
    cwd: webDir,
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${cmdArgs.join(" ")} exited with ${result.status}`);
  }
}

function gitSha() {
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: webDir });
  const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: webDir }).stdout.length > 0;
  return `${result.stdout.toString().trim()}${dirty ? "-dirty" : ""}`;
}

// Records which commit dist/ and dist-mock/ were built from, so a --skip-build
// run reports the commit it measured rather than the one checked out now.
const buildMarker = join(webDir, "perf", ".results", "build-sha");

function build() {
  run("pnpm", ["build:kit"]);
  // Source maps stay on (the default outside the compiled Docker mode) so the
  // initial chunks can be attributed to the packages that produced them.
  run("pnpm", ["exec", "rsbuild", "build"], { ROME_DOCKER_APP_CODE_MODE: "" });
  run("pnpm", ["exec", "rsbuild", "build", "--config", "mock/rsbuild.static.config.ts"]);
  mkdirSync(dirname(buildMarker), { recursive: true });
  writeFileSync(buildMarker, gitSha());
}

function builtSha() {
  const current = gitSha();
  const built = existsSync(buildMarker) ? readFileSync(buildMarker, "utf8").trim() : "unknown";
  if (built !== current) {
    console.log(
      `WARNING: dist/ was built from ${built}, but ${current} is checked out. ` +
        "The result is labeled with the built commit. Run without --skip-build to measure the checkout.",
    );
  }
  return built;
}

// ---------------------------------------------------------------------------
// Bundle

function sizes(file) {
  const buf = readFileSync(file);
  return {
    raw: buf.length,
    gzip: gzipSync(buf, { level: 9 }).length,
    brotli: brotliCompressSync(buf, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
    }).length,
  };
}

function addSizes(a, b) {
  return { raw: a.raw + b.raw, gzip: a.gzip + b.gzip, brotli: a.brotli + b.brotli };
}

const ZERO = { raw: 0, gzip: 0, brotli: 0 };

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

// The assets index.html loads before anything renders: module scripts and
// stylesheets from /static. runtime-config.js is written at container boot
// and is not part of the build.
function initialAssets(distDir) {
  const html = readFileSync(join(distDir, "index.html"), "utf8");
  const scripts = [...html.matchAll(/<script[^>]*\ssrc="(\/static\/[^"]+\.js)"/g)].map((m) => m[1]);
  const styles = [...html.matchAll(/<link[^>]*href="(\/static\/[^"]+\.css)"[^>]*>/g)].map(
    (m) => m[1],
  );
  return { scripts, styles };
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_INDEX = Object.fromEntries([...BASE64].map((c, i) => [c, i]));

function decodeVlq(segment) {
  const values = [];
  let value = 0;
  let shift = 0;
  for (const char of segment) {
    const digit = BASE64_INDEX[char];
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
    } else {
      values.push(value & 1 ? -(value >> 1) : value >> 1);
      value = 0;
      shift = 0;
    }
  }
  return values;
}

function packageOf(source) {
  if (!source) return "(unmapped)";
  const nm = source.match(/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/);
  if (nm) return nm[1];
  if (source.includes("packages/ui/")) return "(rome-ui)";
  if (source.includes("packages/web/") || /(^|\/)src\//.test(source)) return "(rome-web)";
  return "(other)";
}

// Generated bytes per source package, read from the chunk's source map. This
// counts what the minifier kept, so tree-shaken code is not charged to the
// package it came from.
function attribute(jsFile, totals) {
  const mapFile = `${jsFile}.map`;
  if (!existsSync(mapFile)) return false;
  const map = JSON.parse(readFileSync(mapFile, "utf8"));
  const lines = readFileSync(jsFile, "utf8").split("\n");
  const packages = map.sources.map(packageOf);
  let source = 0;
  map.mappings.split(";").forEach((line, lineIx) => {
    const lineText = lines[lineIx] ?? "";
    let column = 0;
    let prevColumn = null;
    let prevPackage = null;
    for (const segment of line.split(",")) {
      if (!segment) continue;
      // Only the generated column and the source index matter for attribution,
      // so the original line, column and name fields are left undecoded.
      const [colDelta, srcDelta] = decodeVlq(segment);
      column += colDelta;
      if (prevColumn !== null) {
        totals[prevPackage] = (totals[prevPackage] ?? 0) + (column - prevColumn);
      }
      if (srcDelta !== undefined) {
        source += srcDelta;
        prevPackage = packages[source];
      } else {
        prevPackage = "(unmapped)";
      }
      prevColumn = column;
    }
    if (prevColumn !== null) {
      totals[prevPackage] = (totals[prevPackage] ?? 0) + (lineText.length - prevColumn);
    }
  });
  return true;
}

function measureBundle() {
  const distDir = join(webDir, "dist");
  if (!existsSync(join(distDir, "index.html"))) {
    throw new Error("packages/web/dist is missing; run without --skip-build");
  }
  const { scripts, styles } = initialAssets(distDir);
  const initialJs = scripts.reduce((acc, src) => addSizes(acc, sizes(join(distDir, src))), ZERO);
  const initialCss = styles.reduce((acc, href) => addSizes(acc, sizes(join(distDir, href))), ZERO);

  const files = walk(join(distDir, "static"));
  const jsFiles = files.filter((f) => f.endsWith(".js"));
  const totalJs = jsFiles.reduce((acc, f) => acc + statSync(f).size, 0);
  const totalCss = files
    .filter((f) => f.endsWith(".css"))
    .reduce((acc, f) => acc + statSync(f).size, 0);

  const byPackage = {};
  const attributed = scripts.map((src) => attribute(join(distDir, src), byPackage));
  const topPackages = Object.entries(byPackage)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([name, bytes]) => ({ name, bytes }));

  return {
    initialJs,
    initialCss,
    initialChunks: scripts.map((src) => ({ src, ...sizes(join(distDir, src)) })),
    totalJsRaw: totalJs,
    totalCssRaw: totalCss,
    asyncChunkCount: jsFiles.filter((f) => relative(distDir, f).includes("/async/")).length,
    initialTopPackages: attributed.every(Boolean) ? topPackages : null,
  };
}

// ---------------------------------------------------------------------------
// Runtime

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".webmanifest": "application/manifest+json",
};

const sleep = (ms) => new Promise((ok) => setTimeout(ok, Math.max(0, ms)));
const CHUNK_BYTES = 16 * 1024;

// Serves dist-mock the way production does: gzip on text assets, and the SPA's
// index.html for any path that is not a file. The server also applies the
// network profile itself. Chromium's network emulation is per page, so it
// misses the requests MSW's service worker makes on the page's behalf, and
// those include every lazy chunk. Each response waits one round trip, then
// sends its body in chunks paced against one link shared by all responses.
function serve(root) {
  const gzipCache = new Map();
  const bytesPerMs = (NETWORK.downloadKbps * 1000) / 8 / 1000;
  let linkFreeAt = 0;
  const stats = { jsBytes: 0, jsRequests: 0 };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    let file = join(root, decodeURIComponent(url.pathname));
    await sleep(NETWORK.latencyMs);
    if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
      if (extname(url.pathname)) {
        res.writeHead(404).end();
        return;
      }
      file = join(root, "index.html");
    }
    const ext = extname(file);
    const headers = { "Content-Type": MIME[ext] ?? "application/octet-stream" };
    let body = readFileSync(file);
    if ([".html", ".js", ".css", ".json", ".svg"].includes(ext)) {
      if (!gzipCache.has(file)) gzipCache.set(file, gzipSync(body, { level: 6 }));
      body = gzipCache.get(file);
      headers["Content-Encoding"] = "gzip";
    }
    if (ext === ".js") {
      stats.jsBytes += body.length;
      stats.jsRequests += 1;
    }
    res.writeHead(200, { ...headers, "Content-Length": body.length });
    for (let offset = 0; offset < body.length; offset += CHUNK_BYTES) {
      const chunk = body.subarray(offset, offset + CHUNK_BYTES);
      const now = performance.now();
      linkFreeAt = Math.max(now, linkFreeAt) + chunk.length / bytesPerMs;
      await sleep(linkFreeAt - now);
      res.write(chunk);
    }
    res.end();
  });
  server.stats = stats;
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

// Runs in the page before any app script. Records paint timings, long tasks,
// and the moment the scenario's ready selector first appears.
function collectorScript(readySelector) {
  const perf = { fcp: null, lcp: null, ready: null, longTasks: [] };
  window.__perf = perf;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.name === "first-contentful-paint") perf.fcp = entry.startTime;
    }
  }).observe({ type: "paint", buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) perf.lcp = entry.startTime;
  }).observe({ type: "largest-contentful-paint", buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      perf.longTasks.push({ start: entry.startTime, duration: entry.duration });
    }
  }).observe({ type: "longtask", buffered: true });
  const check = () => {
    if (perf.ready === null && document.querySelector(readySelector)) {
      perf.ready = performance.now();
      observer.disconnect();
    }
  };
  const observer = new MutationObserver(check);
  document.addEventListener("DOMContentLoaded", () => {
    observer.observe(document.documentElement, { childList: true, subtree: true });
    check();
  });
}

async function measureOnce(browser, server, scenario) {
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });
  await page.addInitScript(collectorScript, scenario.ready);

  server.stats.jsBytes = 0;
  server.stats.jsRequests = 0;
  await page.goto(`${origin}${scenario.path}`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__perf?.ready !== null, null, { timeout: 60_000 });
  // Let lazy chunks, queries and the work they trigger settle so long tasks
  // that follow the ready signal are counted too.
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1000);

  const perf = await page.evaluate(() => window.__perf);
  const { jsBytes, jsRequests } = server.stats;
  await cdp.send("HeapProfiler.collectGarbage");
  const heap = await cdp.send("Runtime.getHeapUsage");
  await context.close();

  // Total blocking time from first paint to settle: the part of each long
  // task beyond 50 ms, as Lighthouse counts it.
  const tbt = perf.longTasks
    .filter((t) => t.start >= (perf.fcp ?? 0))
    .reduce((acc, t) => acc + Math.max(0, t.duration - 50), 0);
  const longestTask = perf.longTasks.reduce((acc, t) => Math.max(acc, t.duration), 0);
  return {
    fcpMs: perf.fcp,
    lcpMs: perf.lcp,
    readyMs: perf.ready,
    tbtMs: tbt,
    longestTaskMs: longestTask,
    jsTransferredBytes: jsBytes,
    jsRequests,
    heapUsedBytes: heap.usedSize,
  };
}

function summarize(samples) {
  const keys = Object.keys(samples[0]);
  return Object.fromEntries(
    keys.map((key) => {
      const values = samples
        .map((s) => s[key])
        .filter((v) => typeof v === "number")
        .sort((a, b) => a - b);
      const median = values.length
        ? values.length % 2
          ? values[(values.length - 1) / 2]
          : (values[values.length / 2 - 1] + values[values.length / 2]) / 2
        : null;
      return [key, { median, min: values[0] ?? null, max: values.at(-1) ?? null }];
    }),
  );
}

async function measureRuntime() {
  const mockDir = join(webDir, "dist-mock");
  if (!existsSync(join(mockDir, "index.html"))) {
    throw new Error("packages/web/dist-mock is missing; run without --skip-build");
  }
  const { chromium } = await import("@playwright/test");
  const executablePath = process.env.PERF_CHROMIUM_PATH || undefined;
  // Only the local server resolves. index.html loads a render-blocking Google
  // Fonts stylesheet, and timing a live round trip to Google would add noise
  // the repo does not control, so external hosts fail fast and the page
  // renders with fallback fonts.
  const browser = await chromium.launch({
    executablePath,
    args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
  });
  const server = await serve(mockDir);
  const results = {};
  try {
    for (const scenario of SCENARIOS) {
      // One unmeasured warm-up so the OS file cache and the server's gzip cache
      // do not make the first measured run an outlier.
      await measureOnce(browser, server, scenario);
      const samples = [];
      for (let i = 0; i < RUNS; i++) {
        samples.push(await measureOnce(browser, server, scenario));
        console.error(`  ${scenario.name} run ${i + 1}/${RUNS}`);
      }
      results[scenario.name] = summarize(samples);
    }
  } finally {
    await browser.close();
    server.close();
  }
  return results;
}

// ---------------------------------------------------------------------------
// Report

function kb(bytes) {
  return bytes == null ? "-" : `${(bytes / 1024).toFixed(1)} KB`;
}

function ms(value) {
  return value == null ? "-" : `${Math.round(value)} ms`;
}

function delta(current, base) {
  if (current == null || base == null || base === 0) return "";
  const pct = ((current - base) / base) * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

function headline(result) {
  const rows = [
    ["Initial JS (gzip)", result.bundle.initialJs.gzip, kb],
    ["Initial JS (brotli)", result.bundle.initialJs.brotli, kb],
    ["Initial JS (raw)", result.bundle.initialJs.raw, kb],
    ["Initial CSS (gzip)", result.bundle.initialCss.gzip, kb],
    ["All JS (raw)", result.bundle.totalJsRaw, kb],
  ];
  for (const [name, metrics] of Object.entries(result.runtime ?? {})) {
    rows.push(
      [`${name} FCP`, metrics.fcpMs.median, ms],
      [`${name} LCP`, metrics.lcpMs.median, ms],
      [`${name} ready`, metrics.readyMs.median, ms],
      [`${name} TBT`, metrics.tbtMs.median, ms],
      [`${name} longest task`, metrics.longestTaskMs.median, ms],
      [`${name} JS transferred`, metrics.jsTransferredBytes.median, kb],
      [`${name} JS heap`, metrics.heapUsedBytes.median, kb],
    );
  }
  return rows;
}

// Settings that change what the page-load numbers mean. A baseline measured
// under different ones still prints, behind a warning naming each difference.
function settingsMismatch(result, baseline) {
  const keys = ["cpuThrottle", "network", "scenarios", "runs"];
  return keys.filter(
    (key) => JSON.stringify(result.meta[key]) !== JSON.stringify(baseline.meta[key]),
  );
}

function report(result, baseline) {
  const rows = headline(result);
  const mismatched = baseline && result.runtime ? settingsMismatch(result, baseline) : [];
  if (mismatched.length) {
    console.log(
      `\nWARNING: the baseline was measured with different settings (${mismatched.join(", ")}). ` +
        "Page-load deltas below are not comparable. Save a new baseline with these settings.",
    );
  }
  const baseRows = baseline ? new Map(headline(baseline).map(([n, v]) => [n, v])) : null;
  const width = Math.max(...rows.map(([n]) => n.length));
  console.log(
    `\nrome-web perf @ ${result.meta.sha}${baseline ? `  vs  ${baseline.meta.sha}` : ""}`,
  );
  for (const [name, value, fmt] of rows) {
    const base = baseRows?.get(name);
    const cols = [name.padEnd(width), fmt(value).padStart(11)];
    if (baseRows) cols.push(fmt(base).padStart(11), delta(value, base).padStart(8));
    console.log(cols.join("  "));
  }
  if (result.runtime) {
    const spread = Object.entries(result.runtime).map(([name, m]) => {
      return `${name} ready ${ms(m.readyMs.min)}-${ms(m.readyMs.max)}`;
    });
    const baseRuns = baseline?.runtime ? ` (baseline: ${baseline.meta.runs} runs)` : "";
    console.log(`\nSpread over ${RUNS} runs${baseRuns}: ${spread.join(", ")}`);
  }
  if (result.bundle.initialTopPackages) {
    console.log("\nLargest packages in the initial JS (minified bytes):");
    for (const { name, bytes } of result.bundle.initialTopPackages.slice(0, 10)) {
      console.log(`  ${kb(bytes).padStart(10)}  ${name}`);
    }
  }
}

// ---------------------------------------------------------------------------

if (!args["skip-build"]) build();

const result = {
  meta: {
    sha: builtSha(),
    date: new Date().toISOString(),
    runs: RUNS,
    cpuThrottle: CPU_THROTTLE,
    network: NETWORK,
    scenarios: SCENARIOS,
  },
  bundle: measureBundle(),
  runtime: args["bundle-only"] ? null : await measureRuntime(),
};

mkdirSync(resultsDir, { recursive: true });
const outFile = resolve(args.out ?? join(resultsDir, "latest.json"));
writeFileSync(outFile, `${JSON.stringify(result, null, 2)}\n`);

const baselineFile = args.baseline ? resolve(args.baseline) : defaultBaseline;
const baseline = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, "utf8")) : null;
report(result, baseline);

if (args["save-baseline"]) {
  writeFileSync(defaultBaseline, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`\nSaved as baseline: ${relative(process.cwd(), defaultBaseline)}`);
}
console.log(`Result: ${relative(process.cwd(), outFile)}`);
