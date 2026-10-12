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
    inputs: { publish_pages: true },
    vars: { MIDSCENE_PUBLISH_REPO: "" },
    needs: {
      midscene: { result: "success" },
      "report-summary": {
        result: "success",
        outputs: { "report-artifact-name": "midscene-e2e-report" },
      },
      "prepare-pages": { result: "success" },
      "deploy-report": { result: "success", outputs: { "page-url": "https://example.test/rome/" } },
    },
    ...overrides,
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

test("model runs retain upstream and fork trust gates without harness dependencies", () => {
  assert.doesNotMatch(workflow, /harness-validation/);
  assert.equal(runs("midscene", { github: { repository: "example/rome", ref: "refs/heads/main", event_name: "schedule" } }), false);
  assert.equal(runs("midscene", { github: { repository: "example/rome", ref: "refs/heads/main", event_name: "workflow_dispatch" } }), true);
  assert.equal(runs("midscene", { github: { repository: "rome-os/rome", ref: "refs/heads/feature", event_name: "workflow_dispatch" } }), false);
  assert.equal(runs("midscene", { github: { repository: "rome-os/rome", ref: "refs/heads/main", event_name: "pull_request" } }), false);
});

test("report preparation does not depend on the publisher repository", () => {
  for (const repository of ["rome-os/rome", "example/rome"]) {
    for (const result of ["success", "failure"]) {
      assert.equal(
        runs("report-summary", {
          github: { repository, ref: "refs/heads/main", event_name: "workflow_dispatch" },
          needs: { midscene: { result } },
        }),
        true,
      );
    }
  }
  assert.equal(runs("report-summary", { needs: { midscene: { result: "skipped" } } }), false);
  assert.doesNotMatch(
    job("report-summary"),
    /configure-pages|pages: write|--pages-url|MIDSCENE_PUBLISH_REPO/,
  );
  assert.match(job("report-summary"), /include-hidden-files: true/);
  assert.doesNotMatch(job("report-summary"), /GITHUB_STEP_SUMMARY/);
  assert.doesNotMatch(job("midscene"), /GITHUB_STEP_SUMMARY/);
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

test("missing Pages configuration cannot block preparation or trigger deployment", () => {
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
  assert.match(job("prepare-pages"), /trusted-report-runs.mjs find-previous/);
  assert.doesNotMatch(job("deploy-report"), /checkout|render-ci-summary|run:/);
  assert.doesNotMatch(job("report-results"), /pages: write|id-token: write|secrets\./);
  assert.match(job("report-results"), /needs.deploy-report.result == 'success'/);
  assert.doesNotMatch(workflow, /published-links-only|published-summary:/);
});

test("manual dispatch can run tests and generate the Summary without Pages", () => {
  const context = {
    github: {
      repository: "example/rome",
      ref: "refs/heads/feature",
      event_name: "workflow_dispatch",
    },
    inputs: { publish_pages: false },
    vars: { MIDSCENE_PUBLISH_REPO: "example/rome" },
  };
  assert.equal(runs("midscene", context), true);
  assert.equal(runs("report-summary", context), true);
  assert.equal(runs("prepare-pages", context), false);
  assert.equal(runs("report-results", context), true);
});

test("results are visible before optional deployment and survive its cancellation", () => {
  const writers = [...workflow.matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:|$(?![\s\S]))/gm)]
    .filter((match) => match[2].includes("GITHUB_STEP_SUMMARY"))
    .map((match) => match[1]);
  assert.deepEqual(writers, ["available-results", "report-results"]);
  assert.match(job("available-results"), /needs: \[midscene, report-summary\]/);
  assert.doesNotMatch(job("available-results"), /needs:.*(?:prepare-pages|deploy-report)/);
  for (const result of ["waiting", "cancelled", "failure", "skipped"]) {
    assert.equal(
      runs("available-results", {
        needs: {
          midscene: { result: "success" },
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
    /needs: \[midscene, report-summary, prepare-pages, deploy-report\]/,
  );
  assert.match(
    job("report-results"),
    /name: Write the run Summary\n        if: always\(\)/,
  );
  assert.match(job("report-summary"), /--require-report/);
  assert.doesNotMatch(job("midscene"), /strategy:|matrix\.|MIDSCENE_INCLUDE_TAGS/);
  assert.match(job("midscene"), /MIDSCENE_PROJECT_NAME: web/);
  assert.match(job("midscene"), /220m npm test/);
  assert.match(workflow, /cron: "0 6 \* \* \*"/);
});

test("the final Summary survives preparation and publication failures or skips", () => {
  for (const reportResult of ["success", "failure", "skipped"]) {
    for (const publicationResult of ["success", "failure", "skipped", "cancelled"]) {
      assert.equal(
        runs("report-results", {
          needs: {
            midscene: { result: "failure" },
            "report-summary": { result: reportResult },
            "deploy-report": { result: publicationResult },
          },
        }),
        true,
      );
    }
  }
  assert.equal(runs("report-results", { needs: { midscene: { result: "skipped" } } }), false);
  assert.equal(runs("report-results", { cancelled: true }), false);
  assert.equal(
    runs("report-results", {
      github: { event_name: "pull_request" },
    }),
    false,
  );
});

test("report downloads use the current run and expose no historical rebuild input", () => {
  assert.doesNotMatch(workflow, /report_source_run_id|REPORT_SOURCE_RUN_ID|validate-source/);
  for (const name of ["report-summary", "report-results"]) {
    assert.doesNotMatch(job(name), /run-id:|github-token:/);
  }
  assert.match(job("report-results"), /name: Recover available test reports[\s\S]*?steps.prepared-report.outcome != 'success'/);
});

test("model steps use environment variables and keep the API key in secrets", () => {
  const visual = job("midscene");
  assert.match(visual, /^    environment: Model$/m);
  assert.match(visual, /MIDSCENE_MODEL_API_KEY: \$\{\{ secrets\.MIDSCENE_MODEL_API_KEY \}\}/);
  assert.doesNotMatch(visual, /vars\.MIDSCENE_MODEL_API_KEY/);
  for (const setting of ["NAME", "BASE_URL", "FAMILY"]) {
    const key = `MIDSCENE_MODEL_${setting}`;
    const bindings = visual.split("\n").filter((line) => line.trimStart().startsWith(`${key}:`));
    assert.ok(bindings.length >= 2);
    for (const binding of bindings) {
      assert.ok(binding.includes(`vars.${key} || secrets.${key}`));
    }
  }
});


test("uses native result.md and only downloads the full-suite artifact", () => {
  for (const name of ["report-summary", "report-results"]) {
    const content = job(name);
    assert.match(content, /write-native-summary\.mjs/);
    assert.doesNotMatch(content, /render-ci-summary|merge-native-reports|shard-/);
    assert.match(content, /name: midscene-results/);
  }
  assert.match(job("report-summary"), /--require-report/);
});

test("project setup owns mock startup and boundary checks", () => {
  assert.doesNotMatch(workflow, /mock-boundary-validation|check:browser-boundary|nohup|name: Start Rome mock server/);
  assert.doesNotMatch(workflow, /^  pull_request:/m);
  assert.match(job("midscene"), /npm test/);
});
