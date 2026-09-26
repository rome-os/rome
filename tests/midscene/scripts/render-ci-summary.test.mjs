import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildSummary, renderMarkdown } from "./render-ci-summary.mjs";

const writeShard = async (root, shard, status, caseName, modelName) => {
  const project = `web-${shard}`;
  const resultRoot = path.join(root, `midscene-${shard}`, ".midscene", "test-results", "run-1");
  const resultFile = path.join(resultRoot, "project-0", "case-1", "attempt.json");
  await mkdir(path.dirname(resultFile), { recursive: true });
  await writeFile(
    resultFile,
    JSON.stringify({
      status,
      durationMs: 12_400,
      steps: [
        {
          id: "step-1",
          status,
          agentDetails: [{ executionId: "execution-1" }],
          ...(status === "success" ? {} : { error: { message: "button missing" } }),
        },
      ],
    }),
  );
  await writeFile(
    path.join(resultRoot, "summary.json"),
    JSON.stringify({
      startedAt: "2026-09-22T01:00:00Z",
      durationMs: 13_000,
      report: "../../../midscene_run/report/midscene-e2e-run-1/index.html",
      projects: [
        {
          name: project,
          status,
          lifecycle: { durationMs: 13_000 },
          cases: [
            {
              caseId: "case-1",
              name: caseName,
              status,
              attempts: [{ resultFile: "project-0/case-1/attempt.json" }],
            },
          ],
        },
      ],
    }),
  );
  const reportRoot = path.join(
    root,
    `midscene-${shard}`,
    "midscene_run",
    "report",
    "midscene-e2e-run-1",
  );
  await mkdir(reportRoot, { recursive: true });
  await mkdir(path.join(reportRoot, "screenshots"));
  await writeFile(
    path.join(reportRoot, "index.html"),
    `<script>window.x={"modelName":"${modelName}"}</script><script type="midscene_test_run_dump">${JSON.stringify(
      {
        projects: [
          {
            documents: [
              {
                cases: [
                  {
                    caseId: "case-1",
                    attempts: [
                      {
                        steps: [
                          {
                            id: "step-1",
                            status,
                            agentDetails: [{ executionId: "execution-1" }],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    )}</script><script type="midscene_web_dump">${JSON.stringify({
      executions: [
        {
          id: "execution-1",
          tasks: [{ uiContext: { screenshot: { id: "screenshot-1" } } }],
        },
      ],
    })}</script>`,
  );
  await writeFile(path.join(reportRoot, "screenshots", "screenshot-1.jpeg"), "image bytes");
  await writeFile(
    path.join(root, `midscene-${shard}`, "midscene_run", "model.json"),
    JSON.stringify({ modelName, modelFamily: "deepseek" }),
  );
};

test("builds one combined Markdown and HTML Summary for all shards", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rome-midscene-summary-"));
  context.after(() =>
    import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })),
  );
  await writeShard(root, "shard-1", "success", "AUTH-01 opens chat", "deepseek-v3.2");
  await writeShard(root, "shard-2", "failed", "CHAT-09 sends a message", "deepseek-v3.2");
  const markdownFile = path.join(root, "summary.md");
  const htmlFile = path.join(root, "index.html");

  const data = await buildSummary({
    "reports-dir": root,
    "expected-projects": "web-shard-1,web-shard-2,web-shard-3",
    "run-url": "https://github.com/quanru/rome/actions/runs/1",
    "pages-url": "https://quanru.github.io/rome/",
    "producer-result": "failure",
    output: markdownFile,
    "html-output": htmlFile,
  });

  assert.deepEqual(data.models, ["deepseek-v3.2 (deepseek)"]);
  const markdown = await readFile(markdownFile, "utf8");
  assert.match(markdown, /Rome × Midscene · failure captured/);
  assert.match(markdown, /2 need attention · 1 passed/);
  assert.match(markdown, /web-shard-3 \| — \| — \| ❌ missing/);
  assert.match(markdown, /CHAT-09 sends a message.*button missing/);
  assert.match(markdown, /<summary>Appendix: passed cases \(1\)<\/summary>/);
  assert.match(markdown, /\| Shard \| Case \| Screenshot \| Status \/ reason \| Duration \|/);
  const appendix = markdown.indexOf("<details>");
  assert.ok(markdown.indexOf("CHAT-09 sends a message") < appendix);
  assert.ok(markdown.indexOf("AUTH-01 opens chat") > appendix);
  assert.match(markdown.slice(0, appendix), /<img[^>]+screenshots\/screenshot-1\.jpeg/);
  assert.match(markdown.slice(appendix), /<img[^>]+screenshots\/screenshot-1\.jpeg/);
  assert.match(markdown, /#runner-step=step-1/);
  assert.match(markdown, /screenshots\/screenshot-1\.jpeg/);
  const page = await readFile(htmlFile, "utf8");
  assert.match(page, /Rome × Midscene Summary/);
  assert.match(page, /deepseek-v3\.2/);
  assert.match(page, /midscene-shard-1\/midscene_run\/report\/midscene-e2e-run-1\/index\.html/);
  assert.match(page, /#runner-step=step-1/);
  assert.match(page, /Node screenshot/);
});

test("escapes Markdown table content", () => {
  const markdown = renderMarkdown({
    projects: [
      {
        name: "web|shard",
        status: "failed",
        durationMs: 1000,
        cases: [
          {
            name: "Case | name",
            status: "failed",
            durationMs: 1000,
            reason: "line 1\nline 2",
            reportPath: "web-shard/report/index.html",
            screenshotPath: "web-shard/previews/case.jpg",
          },
        ],
      },
    ],
    models: [],
    runUrl: "https://example.test/run",
    pagesUrl: "https://example.test/reports/",
    producerResult: "failure",
  });
  assert.match(markdown, /web\\\|shard/);
  assert.match(markdown, /Case \\\| name/);
  assert.match(markdown, /line 1 line 2/);
  assert.match(markdown, /alt="Case &#124; name"/);
});

test("reports a missing expected shard as an overall failure", () => {
  const markdown = renderMarkdown({
    projects: [
      {
        name: "web-shard-1",
        status: "success",
        durationMs: 1000,
        cases: [{ name: "AUTH-01", status: "success", durationMs: 1000, reason: "" }],
      },
      {
        name: "web-shard-2",
        status: "missing",
        durationMs: null,
        cases: [],
      },
    ],
    models: ["deepseek-v3.2 (deepseek)"],
    runUrl: "https://example.test/run",
    pagesUrl: "https://example.test/reports/",
    producerResult: "success",
  });

  assert.match(markdown, /Rome × Midscene · failure captured/);
  assert.match(markdown, /### Needs attention/);
  assert.match(markdown, /web-shard-2.*missing/);
  assert.doesNotMatch(markdown, /All 1 cases passed/);
});

test("celebrates a complete run and keeps passed cases in the appendix", () => {
  const markdown = renderMarkdown({
    projects: [{
      name: "web-shard-1",
      status: "success",
      durationMs: 1000,
      cases: [{
        name: "AUTH-01",
        status: "success",
        durationMs: 1000,
        reportPath: "web-shard-1/report/index.html",
        screenshotPath: "web-shard-1/screenshots/one.jpeg",
        stepId: "step-1",
      }],
    }],
    models: [],
    runUrl: "https://example.test/run",
    pagesUrl: "https://example.test/reports/",
  });
  assert.match(markdown, /\*\*✅ 0 need attention · 1 passed\*\*/);
  assert.match(markdown, /🎉 All 1 cases passed/);
  assert.match(markdown, /<details>\n<summary>Appendix: passed cases \(1\)<\/summary>/);
  assert.match(markdown, /<a href="[^"]+runner-step/);
  assert.doesNotMatch(markdown.slice(0, markdown.indexOf("<details>")), /AUTH-01/);
});
