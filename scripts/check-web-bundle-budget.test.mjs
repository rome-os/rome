import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FIRST_SCREEN_GZIP_BUDGET_BYTES,
  firstScreenScripts,
  judge,
  judgeHtml,
  packageOfSource,
  routePreloadFiles,
  run,
} from "./check-web-bundle-budget.mjs";

const chunk = (overrides = {}) => ({
  file: "static/js/index.abc.js",
  rawBytes: 1000,
  gzipBytes: 400,
  sources: ["webpack://rome-web/./src/App.tsx"],
  ...overrides,
});

const HTML = `<html><head>
<script defer src="/runtime-config.js"></script>
<script data-route-preload="route-chat">(function(){var p=location.pathname;if(!(p==="/"))return;function add(files){}if(p==="/"){add(["/static/js/async/1.js"])}if(p==="/"){late.push.apply(late,["/static/css/async/route-chat.css"])}})();</script>
<script defer type="module" src="/static/js/lib-react.1.js"></script>
<script defer type="module" src="/static/js/index.2.js"></script>
<link href="/static/css/index.3.css" rel="stylesheet">
</head></html>`;

test("firstScreenScripts lists the bundle scripts and skips the runtime-config stub", () => {
  assert.deepEqual(firstScreenScripts(HTML), ["static/js/lib-react.1.js", "static/js/index.2.js"]);
});

test("routePreloadFiles reads the list the plugin wrote", () => {
  assert.deepEqual(routePreloadFiles(HTML), [
    "static/js/async/1.js",
    "static/css/async/route-chat.css",
  ]);
  assert.equal(routePreloadFiles("<html></html>"), null);
});

test("packageOfSource names the package a source belongs to, scoped or not", () => {
  assert.equal(
    packageOfSource(
      "webpack://x/../../node_modules/.pnpm/shiki@3.0.0/node_modules/shiki/dist/index.mjs",
    ),
    "shiki",
  );
  assert.equal(
    packageOfSource(
      "webpack://x/../../node_modules/.pnpm/a@1/node_modules/@shikijs/core/dist/a.mjs",
    ),
    "@shikijs/core",
  );
  assert.equal(packageOfSource("webpack://x/./src/App.tsx"), null);
});

test("a first screen inside the budget passes", () => {
  const { problems, totalGzip } = judge({ chunks: [chunk(), chunk({ file: "b.js" })] });
  assert.deepEqual(problems, []);
  assert.equal(totalGzip, 800);
});

test("a first screen over the budget fails and says by how much", () => {
  const { problems } = judge({
    chunks: [chunk({ gzipBytes: FIRST_SCREEN_GZIP_BUDGET_BYTES + 1024 })],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /over the .* KB budget/);
});

test("a forbidden library in an initial chunk fails, whichever form its package name takes", () => {
  for (const source of [
    "webpack://x/../node_modules/.pnpm/mermaid@11/node_modules/mermaid/dist/m.js",
    "webpack://x/../node_modules/.pnpm/a@1/node_modules/@shikijs/langs/dist/ts.mjs",
    "webpack://x/../node_modules/.pnpm/a@1/node_modules/katex/dist/katex.mjs",
    "webpack://x/../node_modules/.pnpm/a@1/node_modules/monaco-editor/esm/a.js",
    "webpack://x/../node_modules/.pnpm/a@1/node_modules/@monaco-editor/loader/lib/a.js",
    "webpack://x/../node_modules/.pnpm/a@1/node_modules/@novnc/novnc/core/rfb.js",
  ]) {
    const { problems } = judge({ chunks: [chunk({ sources: [source] })] });
    assert.equal(problems.length, 1, source);
    assert.match(problems[0], /into the first screen/);
  }
});

test("a package that only shares a prefix with a forbidden one is allowed", () => {
  const { problems } = judge({
    chunks: [
      chunk({ sources: ["webpack://x/../node_modules/.pnpm/a@1/node_modules/katex-extras/a.js"] }),
    ],
  });
  assert.deepEqual(problems, []);
});

test("a chunk without a source map fails instead of passing unchecked", () => {
  const { problems } = judge({ chunks: [chunk({ sources: null })] });
  assert.match(problems[0], /no source map/);
});

test("a build whose HTML loads no bundle fails", () => {
  assert.match(judge({ chunks: [] }).problems[0], /loads no scripts/);
});

test("the HTML may not load fonts from Google", () => {
  const problems = judgeHtml({
    html: `${HTML}<link href="https://fonts.googleapis.com/css2?family=X">`,
    fileExists: () => true,
    firstScreen: [],
  });
  assert.ok(problems.some((p) => /Google Fonts/.test(p)));
});

test("the route-preload list must name files the build has, and no first-screen chunk", () => {
  const problems = judgeHtml({
    html: HTML,
    fileExists: (file) => file !== "static/css/async/route-chat.css",
    firstScreen: ["static/js/async/1.js"],
  });
  assert.equal(problems.length, 2);
  assert.ok(problems.some((p) => /not in the build/.test(p)));
  assert.ok(problems.some((p) => /repeats first-screen chunk/.test(p)));
});

test("run measures a built directory end to end", () => {
  const dist = mkdtempSync(join(tmpdir(), "web-budget-"));
  try {
    mkdirSync(join(dist, "static/js/async"), { recursive: true });
    mkdirSync(join(dist, "static/css/async"), { recursive: true });
    writeFileSync(join(dist, "index.html"), HTML);
    writeFileSync(join(dist, "static/js/lib-react.1.js"), "a".repeat(5000));
    writeFileSync(
      join(dist, "static/js/lib-react.1.js.map"),
      JSON.stringify({ sources: ["webpack://x/../node_modules/react-dom/a.js"] }),
    );
    writeFileSync(join(dist, "static/js/index.2.js"), "b".repeat(5000));
    writeFileSync(
      join(dist, "static/js/index.2.js.map"),
      JSON.stringify({ sources: ["webpack://x/./src/main.tsx"] }),
    );
    writeFileSync(join(dist, "static/js/async/1.js"), "c");
    writeFileSync(join(dist, "static/css/async/route-chat.css"), "d");
    const result = run(dist);
    assert.deepEqual(result.problems, []);
    assert.equal(result.chunks.length, 2);
    assert.equal(result.totalRaw, 10000);
    assert.ok(result.totalGzip < 200);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});
