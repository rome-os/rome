import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../../../.github/workflows/midscene.yml", import.meta.url),
  "utf8",
);
const job = (name) => {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1);
  const end = workflow.slice(start + 1).search(/\n  [\w-]+:\n/);
  return workflow.slice(start, end < 0 ? undefined : start + 1 + end);
};
const runs = (name, overrides = {}) => {
  const condition = job(name).match(/^    if: >-\n((?:      .+\n)+)/m)?.[1];
  assert.ok(condition, `${name} must have an explicit job gate`);
  const context = {
    github: { repository: "rome-os/rome", ref: "refs/heads/main", event_name: "push" },
    inputs: { report_source_run_id: "", publish_pages: true },
    vars: { MIDSCENE_PUBLISH_REPO: "" },
    needs: {
      mock: { result: "success" },
      backend: { result: "success" },
      "report-summary": {
        result: "success",
        outputs: { "report-artifact-name": "midscene-e2e-report" },
      },
      "prepare-pages": { result: "success" },
      "deploy-report": { result: "success", outputs: { "page-url": "https://example.test/rome/" } },
    },
    ...overrides,
  };
  context.needs = {
    "harness-validation": {
      result: "success",
      outputs: { "upstream-repository": "rome-os/rome" },
    },
    ...context.needs,
  };
  // Evaluate the workflow's actual gate so a policy edit changes these cases.
  const expression = condition
    .replace(/needs\.([\w-]+)\./g, 'needs["$1"].')
    .replace(/outputs\.([\w-]+)/g, 'outputs["$1"]');
  return Function(
    "github",
    "inputs",
    "vars",
    "needs",
    "always",
    "cancelled",
    `return (${expression});`,
  )(
    context.github,
    context.inputs,
    context.vars,
    context.needs,
    () => true,
    () => context.cancelled ?? false,
  );
};

test("trust gates share one upstream definition and fail closed without it", () => {
  assert.equal((workflow.match(/rome-os\/rome/g) ?? []).length, 1);
  for (const name of ["mock", "backend", "prepare-pages"]) {
    assert.equal(
      runs(name, {
        needs: { "harness-validation": { outputs: { "upstream-repository": "" } } },
      }),
      false,
    );
  }
});

test("report aggregation does not depend on the publisher repository", () => {
  for (const repository of ["rome-os/rome", "example/rome"]) {
    for (const result of ["success", "failure"]) {
      assert.equal(
        runs("report-summary", {
          github: { repository, ref: "refs/heads/main", event_name: "workflow_dispatch" },
          needs: { mock: { result }, backend: { result } },
        }),
        true,
      );
    }
  }
  const bothSkipped = { mock: { result: "skipped" }, backend: { result: "skipped" } };
  assert.equal(runs("report-summary", { needs: bothSkipped }), false);
  for (const suite of ["mock", "backend"]) {
    // A single-suite run still produces the report.
    assert.equal(
      runs("report-summary", { needs: { ...bothSkipped, [suite]: { result: "success" } } }),
      true,
    );
  }
  assert.equal(
    runs("report-summary", {
      needs: bothSkipped,
      inputs: { report_source_run_id: "123" },
    }),
    true,
  );
  assert.doesNotMatch(
    job("report-summary"),
    /configure-pages|pages: write|--pages-url|MIDSCENE_PUBLISH_REPO/,
  );
  assert.match(job("report-summary"), /include-hidden-files: true/);
  assert.doesNotMatch(job("report-summary"), /GITHUB_STEP_SUMMARY/);
  for (const suite of ["mock", "backend"]) {
    assert.doesNotMatch(job(suite), /GITHUB_STEP_SUMMARY/);
  }
});

test("Pages defaults to upstream main and requires explicit fork opt-in", () => {
  assert.equal(runs("prepare-pages"), true);
  assert.equal(runs("prepare-pages", { vars: { MIDSCENE_PUBLISH_REPO: "other/rome" } }), true);
  for (const event_name of ["push", "workflow_dispatch", "pull_request"]) {
    for (const repository of ["rome-os/rome", "example/rome"]) {
      for (const ref of ["refs/heads/main", "refs/heads/feature", "refs/pull/1/merge"]) {
        for (const publisher of ["", repository, "other/rome"]) {
          const expected =
            event_name !== "pull_request" &&
            (repository === "rome-os/rome"
              ? ref === "refs/heads/main"
              : publisher === repository && event_name === "workflow_dispatch");
          assert.equal(
            runs("prepare-pages", {
              github: { repository, ref, event_name },
              vars: { MIDSCENE_PUBLISH_REPO: publisher },
            }),
            expected,
            `${repository} ${event_name} ${ref} ${publisher}`,
          );
        }
      }
    }
  }
});

test("missing Pages configuration cannot block aggregation or trigger deployment", () => {
  const publication = job("prepare-pages");
  assert.match(publication, /id: pages\n        continue-on-error: true/);
  assert.match(publication, /enablement: false/);
  assert.match(publication, /id: upload-pages\n        if: steps.pages.outcome == 'success'/);
  assert.match(publication, /steps.upload-pages.outcome == 'success'/);
  assert.match(job("deploy-report"), /needs.prepare-pages.outputs.pages-artifact-name != ''/);
  assert.equal(
    runs("prepare-pages", {
      needs: { "report-summary": { outputs: { "report-artifact-name": "" } } },
    }),
    false,
  );
});

test("publication validates artifact sources and isolates the deployment token", () => {
  assert.match(job("report-summary"), /trusted-report-runs.mjs validate-source/);
  assert.match(job("prepare-pages"), /trusted-report-runs.mjs find-previous/);
  assert.doesNotMatch(job("deploy-report"), /checkout|render-ci-summary|run:/);
  assert.doesNotMatch(job("report-results"), /pages: write|id-token: write|secrets\./);
  assert.match(job("report-results"), /needs.deploy-report.result == 'success'/);
  assert.doesNotMatch(workflow, /published-links-only|published-summary:/);
});

test("report-only dispatch can generate the Summary without models or Pages", () => {
  const context = {
    github: {
      repository: "example/rome",
      ref: "refs/heads/feature",
      event_name: "workflow_dispatch",
    },
    inputs: { report_source_run_id: "123", publish_pages: false },
    vars: { MIDSCENE_PUBLISH_REPO: "example/rome" },
  };
  assert.equal(runs("mock", context), false);
  assert.equal(runs("backend", context), false);
  assert.equal(runs("report-summary", context), true);
  assert.equal(runs("prepare-pages", context), false);
  assert.equal(runs("report-results", context), true);
});

test("results are visible before optional deployment and survive its cancellation", () => {
  const writers = [...workflow.matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:|$(?![\s\S]))/gm)]
    .filter((match) => match[2].includes("GITHUB_STEP_SUMMARY"))
    .map((match) => match[1]);
  assert.deepEqual(writers, ["available-results", "report-results"]);
  assert.match(job("available-results"), /needs: \[mock, backend, report-summary\]/);
  assert.doesNotMatch(job("available-results"), /needs:.*(?:prepare-pages|deploy-report)/);
  for (const result of ["waiting", "cancelled", "failure", "skipped"]) {
    assert.equal(
      runs("available-results", {
        needs: {
          mock: { result: "success" },
          backend: { result: "success" },
          "report-summary": { result: "success" },
          "deploy-report": { result },
        },
      }),
      true,
    );
  }
  assert.equal(runs("available-results", { github: { event_name: "pull_request" } }), false);
  assert.match(
    job("report-results"),
    /needs: \[harness-validation, mock, backend, report-summary, prepare-pages, deploy-report\]/,
  );
  assert.match(
    job("report-results"),
    /name: Write the consolidated run Summary\n        if: always\(\)/,
  );
  assert.match(job("report-results"), /--case-manifest/);
  assert.doesNotMatch(workflow, /matrix|strategy:/);
  assert.match(workflow, /cron: "0 6 \* \* \*"/);
});

test("the final Summary survives aggregation and publication failures or skips", () => {
  for (const reportResult of ["success", "failure", "skipped"]) {
    for (const publicationResult of ["success", "failure", "skipped", "cancelled"]) {
      assert.equal(
        runs("report-results", {
          needs: {
            mock: { result: "failure" },
            backend: { result: "skipped" },
            "report-summary": { result: reportResult },
            "deploy-report": { result: publicationResult },
          },
        }),
        true,
      );
    }
  }
  assert.equal(
    runs("report-results", {
      needs: { mock: { result: "skipped" }, backend: { result: "skipped" } },
    }),
    false,
  );
  assert.equal(runs("report-results", { cancelled: true }), false);
  assert.equal(
    runs("report-results", {
      github: { event_name: "pull_request" },
      inputs: { report_source_run_id: "123" },
    }),
    false,
  );
});

test("artifact recovery cannot bypass source validation", () => {
  const results = job("report-results");
  assert.match(results, /trusted-report-runs.mjs validate-source/);
  const downloads = results.match(
    /      - name: (?:Download combined Midscene report|Recover available suite reports)[\s\S]*?(?=      - name:)/g,
  );
  assert.equal(downloads.length, 2);
  for (const download of downloads) {
    assert.match(
      download,
      /inputs.report_source_run_id == '' \|\| steps.source-run.outcome == 'success'/,
    );
    assert.match(download, /continue-on-error: true/);
  }
  assert.match(
    results,
    /needs.prepare-pages.result == 'failure' && 'failure' \|\| needs.deploy-report.result/,
  );
  assert.match(
    results,
    /steps.combined-report.outcome == 'success' && 'midscene-combined-report' \|\| 'midscene-reports'/,
  );
  assert.match(
    results,
    /name: Recover available suite reports[\s\S]*?steps.combined-report.outcome != 'success'/,
  );
  assert.doesNotMatch(results, /run:.*\$\{\{ inputs.report_source_run_id/);
});

test("both suites share the model trust gate, and backend runs after mock", () => {
  for (const event_name of ["schedule", "push", "workflow_dispatch", "pull_request"]) {
    for (const repository of ["rome-os/rome", "example/rome"]) {
      for (const ref of ["refs/heads/main", "refs/heads/feature", "refs/pull/1/merge"]) {
        const context = { github: { repository, ref, event_name } };
        assert.equal(
          runs("backend", context),
          runs("mock", context),
          `${repository} ${event_name} ${ref}`,
        );
      }
    }
  }
  assert.match(job("backend"), /needs: \[harness-validation, mock\]/);
  for (const result of ["success", "failure", "skipped"]) {
    assert.equal(runs("backend", { needs: { mock: { result } } }), true, `mock ${result}`);
  }
  assert.equal(runs("backend", { cancelled: true }), false);
  const harnessFailed = {
    result: "failure",
    outputs: { "upstream-repository": "rome-os/rome" },
  };
  assert.equal(runs("backend", { needs: { "harness-validation": harnessFailed } }), false);
});

test("the suite input selects mock, backend, or both, and the report expects the same", () => {
  const dispatch = (suite) => ({
    github: { repository: "rome-os/rome", ref: "refs/heads/main", event_name: "workflow_dispatch" },
    inputs: { report_source_run_id: "", publish_pages: true, suite },
  });
  assert.deepEqual(
    ["all", "mock", "backend", undefined].map((suite) => [
      runs("mock", dispatch(suite)),
      runs("backend", dispatch(suite)),
    ]),
    [
      [true, true],
      [true, false],
      [false, true],
      [true, true],
    ],
  );
  const plan = job("harness-validation");
  assert.match(plan, /mock\) projects=web-mock ;;/);
  assert.match(plan, /backend\) projects=web-backend ;;/);
  assert.match(plan, /\*\) projects=web-mock,web-backend ;;/);
  for (const name of ["report-summary", "report-results"]) {
    assert.match(job(name), /needs.harness-validation.outputs.projects/);
    assert.doesNotMatch(job(name), /web-shard|web-mock,web-backend/);
  }
});

test("both suites follow one step order and upload one suite artifact each", () => {
  const steps = (name) =>
    [...job(name).matchAll(/^      - name: (.+)$/gm)].map((match) => match[1]);
  const shared = [
    "Install Midscene test dependencies",
    "Check Midscene model vision",
    "Type-check Midscene custom nodes",
    "Start the target",
    "Run the suite",
    "Record report model",
    "Upload the suite report",
  ];
  for (const name of ["mock", "backend"]) {
    const order = shared.map((step) => steps(name).findIndex((item) => item.startsWith(step)));
    assert.ok(
      order.every((index, position) => index > (order[position - 1] ?? -1)),
      name,
    );
    assert.match(job(name), new RegExp(`name: midscene-suite-${name}\n`));
  }
  for (const match of workflow.matchAll(/pattern: (\S+)/g)) {
    assert.equal(match[1], "midscene-suite-*");
  }
});

test("the backend report is scanned for secrets before upload", () => {
  const backend = job("backend");
  assert.match(backend, /id: secret-scan\n        if: always\(\)/);
  assert.match(backend, /if: always\(\) && steps.secret-scan.outcome == 'success'/);
  assert.match(backend, /::add-mask::/);
  assert.match(backend, /docker pull "\$ROME_E2E_IMAGE"/);
  assert.doesNotMatch(backend, /build-push-action|setup-buildx/);
});
