#!/usr/bin/env node
// Report everything unexpected that a backend-suite run produced, independent
// of whether the cases passed: error-level container log lines, browser
// console errors, uncaught page errors, failed requests, and HTTP responses of
// 400 or more.
// Entries matching backend/known-noise.json are dropped; each noise entry
// states why it is expected.
//
//   node scripts/backend-anomalies.mjs --rome-log <file> --events <file> \
//     [--image <name@revision>] --out <dir>
//
// Writes <dir>/anomalies.json and <dir>/backend-summary.md, which the backend
// job Summary includes, and prints the Markdown.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    "rome-log": { type: "string" },
    events: { type: "string" },
    noise: { type: "string", default: resolve(import.meta.dirname, "../backend/known-noise.json") },
    image: { type: "string" },
    out: { type: "string", default: "." },
  },
});

const readLines = (path) =>
  path && existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];

const ERROR_LEVELS = new Set(["error", "fatal", 50, 60]);

// Container lines look like `rome-1  | <timestamp> <payload>`. Only JSON
// payloads carry a level; plain-text lines (Tailscale, pnpm) are not graded.
const romeLogEntries = readLines(args["rome-log"]).flatMap((line) => {
  const start = line.indexOf("{");
  if (start < 0) return [];
  let record;
  try {
    record = JSON.parse(line.slice(start));
  } catch {
    return [];
  }
  const unleveledError = record.level === undefined && typeof record.stack === "string";
  if (!ERROR_LEVELS.has(record.level) && !unleveledError) return [];
  return [
    {
      source: "rome-log",
      component: String(record.component ?? record.logger ?? ""),
      message: String(record.message ?? record.msg ?? record.stack ?? "").split("\n")[0],
    },
  ];
});

const eventEntries = readLines(args.events).map((line) => {
  const { at: _at, ...event } = JSON.parse(line);
  return Object.fromEntries(Object.entries(event).map(([key, value]) => [key, String(value)]));
});

const noise = JSON.parse(readFileSync(args.noise, "utf8"));
for (const entry of noise) {
  if (!entry.reason)
    throw new Error(`known-noise entry without a reason: ${JSON.stringify(entry)}`);
}
const isNoise = (entry) =>
  noise.some(
    (rule) =>
      rule.source === entry.source &&
      Object.entries(rule.match).every(([field, pattern]) =>
        new RegExp(pattern).test(entry[field] ?? ""),
      ),
  );

// Group identical entries; dynamic ids in paths stay distinct on purpose so a
// reader sees which resource failed.
const counts = new Map();
let noiseCount = 0;
for (const entry of [...romeLogEntries, ...eventEntries]) {
  if (isNoise(entry)) {
    noiseCount += 1;
    continue;
  }
  const key = JSON.stringify(entry);
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
const anomalies = [...counts].map(([key, count]) => ({ ...JSON.parse(key), count }));

const describe = (a) =>
  a.source === "http"
    ? `${a.status} ${a.method} ${a.path}`
    : a.source === "requestfailed"
      ? `${a.error} ${a.origin}${a.path}`
      : a.source === "rome-log"
        ? `${a.component ? `[${a.component}] ` : ""}${a.message}`
        : a.text;
const markdown = [
  "### Backend suite",
  "",
  ...(args.image ? [`Image: \`${args.image}\``, ""] : []),
  `Anomalies: ${anomalies.length} distinct anomal${anomalies.length === 1 ? "y" : "ies"}; ${noiseCount} known-noise entr${noiseCount === 1 ? "y" : "ies"} dropped.`,
  "",
  ...(anomalies.length
    ? [
        "| Source | Count | Entry |",
        "|---|---:|---|",
        ...anomalies.map(
          (a) =>
            `| ${a.source} | ${a.count} | ${describe(a).replaceAll("|", "\\|").slice(0, 300)} |`,
        ),
      ]
    : []),
  "",
].join("\n");

mkdirSync(args.out, { recursive: true });
writeFileSync(resolve(args.out, "anomalies.json"), `${JSON.stringify(anomalies, null, 2)}\n`);
writeFileSync(resolve(args.out, "backend-summary.md"), markdown);
process.stdout.write(markdown);
