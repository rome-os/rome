#!/usr/bin/env node

import { mkdir, readFile, readdir, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

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

const walk = async (directory, predicate) => {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  })) {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(item, predicate)));
    else if (entry.isFile() && predicate(item)) files.push(item);
  }
  return files;
};

const formatDuration = (durationMs) => {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "—";
  const seconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
};

const markdownCell = (value) =>
  String(value ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll(/[\r\n]+/g, " ");

const html = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const newest = (left, right) =>
  Date.parse(left.startedAt ?? "") >= Date.parse(right.startedAt ?? "") ? left : right;

const normalizedBaseUrl = (value) => {
  const url = new URL(value);
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
};

const reportUrl = (baseUrl, reportPath) => new URL(reportPath, normalizedBaseUrl(baseUrl)).href;

const caseUrl = (baseUrl, testCase) => {
  const url = new URL(testCase.reportPath, normalizedBaseUrl(baseUrl));
  if (testCase.stepId) {
    url.hash = new URLSearchParams({ "runner-step": testCase.stepId }).toString();
  }
  return url.href;
};

const normalizeJsonControlCharacters = (source) => {
  let normalized = "";
  let insideString = false;
  let escaped = false;
  for (const character of source) {
    if (!insideString) {
      normalized += character;
      if (character === '"') insideString = true;
    } else if (escaped) {
      normalized += character;
      escaped = false;
    } else if (character === "\\") {
      normalized += character;
      escaped = true;
    } else if (character === '"') {
      normalized += character;
      insideString = false;
    } else if (character.charCodeAt(0) <= 0x1f) {
      normalized += `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
    } else {
      normalized += character;
    }
  }
  return normalized;
};

const reportDumps = (source) =>
  [
    ...source.matchAll(
      /<script\s+([^>]*\btype=["']midscene_web_dump["'][^>]*)>\s*(\{[\s\S]*?)<\/script>/g,
    ),
  ].map((match) => JSON.parse(normalizeJsonControlCharacters(match[2])));

const testRunDumps = (source) =>
  [
    ...source.matchAll(
      /<script\s+[^>]*\btype=["']midscene_test_run_dump["'][^>]*>\s*(\{[\s\S]*?)<\/script>/g,
    ),
  ].map((match) => JSON.parse(normalizeJsonControlCharacters(match[1])));

const loadAttempt = async (summaryFile, attempt) => {
  if (!attempt?.resultFile) return null;
  const resultFile = path.join(path.dirname(summaryFile), attempt.resultFile);
  return JSON.parse(await readFile(resultFile, "utf8"));
};

const failureReason = (attempt) => {
  const steps = [
    ...(attempt?.beforeEach ?? []),
    ...(attempt?.steps ?? []),
    ...(attempt?.afterEach ?? []),
  ];
  const failed = steps.findLast((step) => step?.status === "failed") ?? attempt;
  const value = failed?.error?.message ?? failed?.error ?? failed?.output?.summary;
  return typeof value === "string" && value.trim() ? value.trim() : "Midscene case failed";
};

const modelsFromReports = async (directory) => {
  const models = new Set();
  const metadataFiles = await walk(directory, (file) => path.basename(file) === "model.json");
  for (const file of metadataFiles) {
    const metadata = JSON.parse(await readFile(file, "utf8"));
    if (metadata.modelName) {
      models.add(
        metadata.modelFamily
          ? `${metadata.modelName} (${metadata.modelFamily})`
          : metadata.modelName,
      );
    }
  }
  if (models.size) return [...models].sort();
  const reports = await walk(directory, (file) => file.endsWith(".html"));
  for (const report of reports) {
    const source = await readFile(report, "utf8");
    for (const match of source.matchAll(/"modelName"\s*:\s*("(?:\\.|[^"\\])*")/g)) {
      try {
        const model = JSON.parse(match[1]);
        if (model) models.add(model);
      } catch {}
    }
  }
  return [...models].sort();
};

const nativeReportFor = async (reportsDirectory, record) => {
  if (record.report) {
    const report = path.resolve(path.dirname(record.summaryFile), record.report);
    return {
      file: report,
      path: path.relative(reportsDirectory, report).split(path.sep).join("/"),
    };
  }
  const { summaryFile } = record;
  const artifactRoot = summaryFile.slice(0, summaryFile.indexOf(`${path.sep}.midscene${path.sep}`));
  const reports = (
    await walk(path.join(artifactRoot, "midscene_run", "report"), (file) => file.endsWith(".html"))
  ).filter((file) => {
    const name = path.basename(file);
    const parent = path.basename(path.dirname(file));
    return (
      name.startsWith("test-run-") ||
      name.startsWith("midscene-e2e-") ||
      parent.startsWith("midscene-e2e-")
    );
  });
  const report = reports.sort().at(-1);
  return report
    ? { file: report, path: path.relative(reportsDirectory, report).split(path.sep).join("/") }
    : null;
};

const evidenceForCase = async (reportsDirectory, report, caseId, passed) => {
  if (!report || !caseId) return {};
  const source = await readFile(report.file, "utf8");
  const reportCase = testRunDumps(source)
    .flatMap((run) => run.projects ?? [])
    .flatMap((project) => project.documents ?? [])
    .flatMap((document) => document.cases ?? [])
    .find((testCase) => testCase.caseId === caseId);
  const attempt = reportCase?.attempts?.at(-1);
  if (!attempt) return {};
  const steps = [
    ...(attempt.beforeEach ?? []),
    ...(attempt.steps ?? []),
    ...(attempt.afterEach ?? []),
  ];
  const hasAgentDetails = (step) => Array.isArray(step?.agentDetails) && step.agentDetails.length;
  const step = passed
    ? steps.findLast(hasAgentDetails)
    : (steps.find((item) => item.status === "failed" && hasAgentDetails(item)) ??
      steps.find((item) => item.status === "failed") ??
      steps.findLast(hasAgentDetails));
  if (!step) return {};

  const dumps = reportDumps(source);
  let screenshotId = null;
  for (const detail of [...(step.agentDetails ?? [])].reverse()) {
    for (const dump of dumps) {
      const execution = dump.executions?.find((item) => item.id === detail.executionId);
      const task = execution?.tasks?.findLast((item) => item.uiContext?.screenshot?.id);
      if (task) {
        screenshotId = task.uiContext.screenshot.id;
        break;
      }
    }
    if (screenshotId) break;
  }

  let screenshotPath = null;
  if (screenshotId) {
    const screenshotDirectory = path.join(path.dirname(report.file), "screenshots");
    const filename = (
      await readdir(screenshotDirectory).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      })
    ).find((name) => name.slice(0, name.lastIndexOf(".")) === screenshotId);
    if (filename) {
      screenshotPath = path
        .relative(reportsDirectory, path.join(screenshotDirectory, filename))
        .split(path.sep)
        .join("/");
    }
  }
  return { stepId: step.id ?? null, screenshotPath };
};

export async function collectReportData(reportsDirectory, expectedProjects = []) {
  const summaryFiles = await walk(
    reportsDirectory,
    (file) => path.basename(file) === "summary.json",
  );
  const summariesByProject = new Map();
  for (const summaryFile of summaryFiles) {
    const summary = JSON.parse(await readFile(summaryFile, "utf8"));
    for (const project of summary.projects ?? []) {
      const record = { ...summary, project, summaryFile };
      const previous = summariesByProject.get(project.name);
      summariesByProject.set(project.name, previous ? newest(previous, record) : record);
    }
  }

  const projectNames = expectedProjects.length
    ? expectedProjects
    : [...summariesByProject.keys()].sort((left, right) =>
        left.localeCompare(right, undefined, { numeric: true }),
      );
  const projects = [];
  for (const name of projectNames) {
    const record = summariesByProject.get(name);
    if (!record) {
      projects.push({ name, status: "missing", durationMs: null, reportPath: null, cases: [] });
      continue;
    }
    const report = await nativeReportFor(reportsDirectory, record);
    const cases = [];
    for (const testCase of record.project.cases ?? []) {
      const attemptRef = testCase.attempts?.at(-1);
      const attempt = await loadAttempt(record.summaryFile, attemptRef).catch(() => null);
      const passed = testCase.status === "success";
      const evidence = await evidenceForCase(reportsDirectory, report, testCase.caseId, passed);
      cases.push({
        name: testCase.name,
        status: testCase.status,
        durationMs: attempt?.durationMs ?? null,
        reason: passed ? "" : failureReason(attempt),
        reportPath: report?.path ?? null,
        ...evidence,
      });
    }
    projects.push({
      name,
      status: record.project.status,
      durationMs: record.project.lifecycle?.durationMs ?? record.durationMs,
      reportPath: report?.path ?? null,
      cases,
    });
  }
  return { projects, models: await modelsFromReports(reportsDirectory) };
}

const totalsFor = (projects) => {
  const cases = projects.flatMap((project) =>
    project.cases.map((testCase) => ({ ...testCase, project: project.name })),
  );
  const passed = cases.filter((testCase) => testCase.status === "success").length;
  return { cases, passed, failed: cases.length - passed, total: cases.length };
};

const caseName = (pagesUrl, testCase) => {
  const name = markdownCell(testCase.name);
  return testCase.reportPath
    ? `[${name}](${caseUrl(pagesUrl, testCase)})`
    : name;
};

const caseScreenshot = (pagesUrl, testCase) => {
  if (!testCase.reportPath || !testCase.screenshotPath) return "—";
  const target = html(caseUrl(pagesUrl, testCase));
  const image = html(reportUrl(pagesUrl, testCase.screenshotPath));
  const name = html(testCase.name).replaceAll("|", "&#124;").replaceAll(/[\r\n]+/g, " ");
  return `<a href="${target}"><img src="${image}" alt="${name}" width="160"></a>`;
};

const caseRow = (pagesUrl, testCase, detail) =>
  `| ${markdownCell(testCase.project)} | ${caseName(pagesUrl, testCase)} | ${caseScreenshot(pagesUrl, testCase)} | ${markdownCell(detail)} | ${formatDuration(testCase.durationMs)} |`;

export function renderMarkdown({ projects, models, pagesUrl, runUrl, producerResult = "success" }) {
  const totals = totalsFor(projects);
  const incompleteProjects = projects.filter((project) => project.status !== "success");
  const failures = totals.cases.filter((testCase) => testCase.status !== "success");
  const passedCases = totals.cases.filter((testCase) => testCase.status === "success");
  const infrastructureFailures = incompleteProjects.filter(
    (project) => !failures.some((testCase) => testCase.project === project.name),
  );
  const unreportedFailure =
    producerResult !== "success" &&
    failures.length === 0 &&
    infrastructureFailures.length === 0;
  const needsAttention = failures.length + infrastructureFailures.length + Number(unreportedFailure);
  const complete =
    producerResult === "success" &&
    totals.total > 0 &&
    needsAttention === 0;
  const sections = [
    `## Rome × Midscene · ${complete ? "passed" : "failure captured"}`,
    "",
    `**${complete ? "✅ " : ""}${needsAttention} need attention · ${passedCases.length} passed**`,
    "",
    `**Models:** ${models.length ? models.map(markdownCell).join(", ") : "not recorded"}`,
    "",
    `**[Open the published HTML report](${reportUrl(pagesUrl, "index.html")})** · [Download the artifact](${runUrl}#artifacts)`,
    "",
  ];

  if (needsAttention) {
    sections.push(
      "### Needs attention",
      "",
      "| Shard | Case | Screenshot | Status / reason | Duration |",
      "|:--|:--|:--|:--|--:|",
      ...infrastructureFailures.map(
        (project) => `| ${markdownCell(project.name)} | — | — | ❌ ${markdownCell(project.status)} · [Workflow run](${runUrl}) | ${formatDuration(project.durationMs)} |`,
      ),
      ...(unreportedFailure
        ? [`| Workflow | — | — | ❌ ${markdownCell(producerResult)} · [Workflow run](${runUrl}) | — |`]
        : []),
      ...failures
        .sort((left, right) =>
          Number(left.status === "not-run") - Number(right.status === "not-run"),
        )
        .map((testCase) => caseRow(
          pagesUrl,
          testCase,
          `${testCase.status === "not-run" ? "⏭️ Not run" : "❌ Failed"}: ${testCase.reason}`,
        )),
      "",
    );
  } else if (complete) {
    sections.push(`🎉 All ${passedCases.length} cases passed.`, "");
  } else {
    sections.push("No cases were reported.", "");
  }

  sections.push(
    "<details>",
    `<summary>Appendix: passed cases (${passedCases.length})</summary>`,
    "",
    "| Shard | Case | Screenshot | Status | Duration |",
    "|:--|:--|:--|:--|--:|",
    ...passedCases.map((testCase) =>
      caseRow(pagesUrl, testCase, "✅ Passed")
      ),
    "",
    "</details>",
    "",
    "Click a screenshot or case name to open its exact step in the native Midscene report.",
    "",
  );
  return sections.join("\n");
}

export function renderHtml({ projects, models, pagesUrl, runUrl }) {
  const totals = totalsFor(projects);
  const rows = totals.cases
    .map((testCase) => {
      const caseName = testCase.reportPath
        ? `<a href="${html(caseUrl(pagesUrl, testCase))}">${html(testCase.name)}</a>`
        : html(testCase.name);
      const screenshot = testCase.screenshotPath
        ? `<a href="${html(caseUrl(pagesUrl, testCase))}"><img src="${html(reportUrl(pagesUrl, testCase.screenshotPath))}" alt="${html(testCase.name)} screenshot" loading="lazy"></a>`
        : "Not available";
      return `<tr><td class="status">${testCase.status === "success" ? "✅" : "❌"}</td><td>${caseName}</td><td>${html(testCase.project)}</td><td>${html(formatDuration(testCase.durationMs))}</td><td class="preview">${screenshot}</td><td>${html(testCase.reason)}</td></tr>`;
    })
    .join("\n");
  const shardRows = projects
    .map((project) => {
      const passed = project.cases.filter((testCase) => testCase.status === "success").length;
      const failed = project.cases.length - passed;
      const name = project.reportPath
        ? `<a href="${html(reportUrl(pagesUrl, project.reportPath))}">${html(project.name)}</a>`
        : html(`${project.name} (missing)`);
      return `<tr><td>${name}</td><td>${passed}</td><td>${failed}</td><td>${html(formatDuration(project.durationMs))}</td></tr>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Rome × Midscene Summary</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:1400px;margin:40px auto;padding:0 24px;color:#172033}h1{margin-bottom:4px}.meta{color:#596579}table{width:100%;border-collapse:collapse;margin:20px 0 32px}th,td{border:1px solid #d8dee9;padding:9px 12px;text-align:left;vertical-align:top}th{background:#f4f6f8}.status{width:30px;text-align:center}.preview{width:240px}.preview img{display:block;width:240px;height:150px;object-fit:cover;border-radius:6px}a{color:#0969da}code{background:#f4f6f8;padding:2px 5px;border-radius:4px}</style></head>
<body><h1>Rome × Midscene Summary</h1>
<p class="meta"><strong>${totals.passed}/${totals.total} cases passed</strong> · Models: ${html(models.join(", ") || "not recorded")} · <a href="${html(runUrl)}">Actions run</a></p>
<h2>Shards</h2><table><thead><tr><th>Shard</th><th>Passed</th><th>Failed</th><th>Duration</th></tr></thead><tbody>${shardRows}</tbody></table>
<h2>Cases</h2><p>Click a case name or screenshot to open its exact Midscene step.</p><table><thead><tr><th></th><th>Case</th><th>Shard</th><th>Duration</th><th>Node screenshot</th><th>Failure</th></tr></thead><tbody>${rows}</tbody></table></body></html>\n`;
}

export async function buildSummary(options) {
  const reportsDirectory = path.resolve(options["reports-dir"]);
  const expectedProjects = (options["expected-projects"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const data = await collectReportData(reportsDirectory, expectedProjects);
  const values = {
    ...data,
    pagesUrl: options["pages-url"],
    runUrl: options["run-url"],
    producerResult: options["producer-result"],
  };
  if (options.output) await appendFile(options.output, `${renderMarkdown(values)}\n`);
  if (options["html-output"]) {
    const output = path.resolve(options["html-output"]);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, renderHtml(values));
  }
  return values;
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  buildSummary(parseArguments(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
