#!/usr/bin/env node

import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const MAX_SITE_BYTES = 900 * 1024 * 1024;
const MAX_RECENT_RUNS = 3;

const parseArguments = (argv) => {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument near ${key ?? "<end>"}`);
    }
    options[key.slice(2)] = value;
  }
  return options;
};

const exists = async (filename) =>
  stat(filename).then(
    () => true,
    () => false,
  );

const bytesIn = async (filename) => {
  const info = await stat(filename);
  if (info.isFile()) return info.size;
  if (!info.isDirectory()) return 0;
  const entries = await readdir(filename);
  return (await Promise.all(entries.map((entry) => bytesIn(path.join(filename, entry))))).reduce(
    (total, bytes) => total + bytes,
    0,
  );
};

// Each suite job runs Midscene once, so its artifact holds one result summary.
// That summary names the native HTML report; return its path relative to the
// suite directory, or null when the run produced no report.
const readSuiteReport = async (suiteDirectory) => {
  const results = path.join(suiteDirectory, ".midscene", "test-results");
  if (!(await exists(results))) return null;
  const summaries = [];
  for (const entry of await readdir(results, { withFileTypes: true })) {
    const file = path.join(results, entry.name, "summary.json");
    if (entry.isDirectory() && (await exists(file))) summaries.push(file);
  }
  if (summaries.length > 1) throw new Error(`Expected one Midscene run in ${suiteDirectory}`);
  if (!summaries.length) return null;
  const { report } = JSON.parse(await readFile(summaries[0], "utf8"));
  if (!report) return null;
  const reportFile = path.resolve(path.dirname(summaries[0]), report);
  const relative = path.relative(path.join(suiteDirectory, "midscene_run", "report"), reportFile);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Native report escapes the report directory in ${suiteDirectory}`);
  }
  return (await exists(reportFile)) ? path.relative(suiteDirectory, reportFile) : null;
};

const toHref = (filename) => filename.split(path.sep).map(encodeURIComponent).join("/");

// Copy each suite's report directory to <current>/<suite>/ and return the
// suites whose native report exists, keyed by suite name.
const copySuiteReports = async (source, current) => {
  const reports = {};
  if (!(await exists(source))) return reports;
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const suite = /^midscene-suite-([a-z]+)$/.exec(entry.name)?.[1];
    if (!entry.isDirectory() || !suite) continue;
    const suiteDirectory = path.join(source, entry.name);
    const reportDirectory = path.join(suiteDirectory, "midscene_run", "report");
    if (!(await exists(reportDirectory))) continue;
    await cp(reportDirectory, path.join(current, suite, "midscene_run", "report"), {
      recursive: true,
    });
    const report = await readSuiteReport(suiteDirectory);
    if (report) reports[suite] = toHref(path.join(suite, report));
  }
  return reports;
};

export async function preparePagesSite({
  site,
  reports,
  runId,
  previous,
  maxSiteBytes = MAX_SITE_BYTES,
}) {
  if (!/^\d+$/.test(runId)) throw new Error("run-id must be numeric");
  await mkdir(site, { recursive: true });

  if (previous && (await exists(path.join(previous, "runs")))) {
    await cp(path.join(previous, "runs"), path.join(site, "runs"), { recursive: true });
  }
  const current = path.join(site, "runs", runId);
  await rm(current, { recursive: true, force: true });
  await mkdir(current, { recursive: true });
  const suiteReports = await copySuiteReports(reports, current);
  const suites = Object.keys(suiteReports).sort();
  if (suites.length) {
    const links = suites.map(
      (suite) => `<li><a href="${suiteReports[suite]}">Midscene Test report: ${suite}</a></li>`,
    );
    await writeFile(
      path.join(current, "index.html"),
      `<!doctype html><html lang="en"><meta charset="utf-8"><title>Midscene run ${runId}</title><h1>Midscene run ${runId}</h1><ul>${links.join("")}</ul></html>`,
    );
  }

  const runsDirectory = path.join(site, "runs");
  const runIds = (await readdir(runsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => Number(left) - Number(right));
  for (const oldRun of runIds.slice(0, -MAX_RECENT_RUNS)) {
    await rm(path.join(runsDirectory, oldRun), { recursive: true });
  }
  const retainedRunIds = runIds.slice(-MAX_RECENT_RUNS);
  while ((await bytesIn(site)) > maxSiteBytes - 10_000 && retainedRunIds.length > 1) {
    const oldRun = retainedRunIds.shift();
    await rm(path.join(runsDirectory, oldRun), { recursive: true });
  }
  const recentLinks = await Promise.all(
    retainedRunIds.map(async (id) =>
      (await exists(path.join(runsDirectory, id, "index.html")))
        ? `<li><a href="runs/${id}/index.html">Run ${id}</a></li>`
        : `<li>Run ${id}: no report was published</li>`,
    ),
  );
  await writeFile(
    path.join(site, "index.html"),
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Midscene reports</title><h1>Midscene reports</h1><p>Recent run reports:</p><ul>${recentLinks.join("")}</ul></html>`,
  );
  const bytes = await bytesIn(site);
  if (bytes > maxSiteBytes) {
    throw new Error(`Pages site is ${bytes} bytes, above the ${maxSiteBytes}-byte safety limit`);
  }
  // Links are relative to runs/<run-id>/ and only name reports that exist.
  return { bytes, runIds: retainedRunIds, reports: suiteReports };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  const result = await preparePagesSite({
    site: options.site,
    reports: options.reports,
    runId: options["run-id"],
    previous: options.previous,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
