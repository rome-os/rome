import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { caseSetIssues } from "./native-results.mjs";
import { writeNativeSummary } from "./write-native-summary.mjs";

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rome-native-summary-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const reportsDirectory = path.join(root, "artifacts");
  const resultDirectory = path.join(reportsDirectory, "midscene-results", ".midscene", "test-results", "run-1");
  await mkdir(resultDirectory, { recursive: true });
  const reportDirectory = path.join(reportsDirectory, "midscene-results", "midscene_run", "report", "test run");
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(path.join(reportDirectory, "index.html"), "report");
  await writeFile(path.join(resultDirectory, "summary.json"), JSON.stringify({
    report: "../../../midscene_run/report/test run/index.html",
  }));
  return { reportsDirectory, resultDirectory, output: path.join(root, "summary.md") };
}

const markdown = `## Midscene Test · failed

**Cases:** 1 total · 0 passed · 1 failed · 0 not run

- [A case](<../../../midscene_run/report/test%20run/index.html#runner-step=step-1>) — failed

  <img src="../../../midscene_run/report/test%20run/screenshots/last.png" alt="Screenshot" width="160">
`;

test("uses native Markdown unchanged except for hosted report asset URLs", async (context) => {
  const input = await fixture(context);
  await writeFile(path.join(input.resultDirectory, "result.md"), markdown);
  assert.equal(await writeNativeSummary({ ...input, pagesUrl: "https://example.test/rome/runs/123" }), true);
  const result = await readFile(input.output, "utf8");
  assert.ok(result.includes("https://example.test/rome/runs/123/midscene-results/midscene_run/report/test%20run/index.html#runner-step=step-1"));
  assert.ok(result.includes("https://example.test/rome/runs/123/midscene-results/midscene_run/report/test%20run/screenshots/last.png"));
  assert.ok(result.includes(">) — failed"));
  assert.ok(result.includes("**Cases:** 1 total · 0 passed · 1 failed · 0 not run"));
});

test("keeps case content without broken image links before publication", async (context) => {
  const input = await fixture(context);
  await writeFile(path.join(input.resultDirectory, "result.md"), markdown);
  assert.equal(await writeNativeSummary(input), true);
  const result = await readFile(input.output, "utf8");
  assert.match(result, /- A case — failed/);
  assert.doesNotMatch(result, /<img|\.png|\.html/);
});

test("fails when native Markdown is missing", async (context) => {
  const input = await fixture(context);
  await assert.rejects(writeNativeSummary(input), { code: "ENOENT" });
});

test("rejects malformed or escaping native links rather than silently rebuilding results", async (context) => {
  const input = await fixture(context);
  for (const target of ["../../../../../../outside.html", "https://other.test/report", "javascript:alert(1)"]) {
    await writeFile(path.join(input.resultDirectory, "result.md"), `[Report](<${target}>)`);
    await assert.rejects(writeNativeSummary({ ...input, pagesUrl: "https://example.test/" }));
  }
});

test("checks missing, duplicate and unexpected cases without shard assignments", () => {
  const summary = { projects: [{ cases: [{ name: "A" }, { name: "A" }, { name: "C" }] }] };
  assert.deepEqual(caseSetIssues(summary, ["A", "B"]), [
    "Duplicate case: A", "Unexpected case: C", "Missing case: B",
  ]);
});
