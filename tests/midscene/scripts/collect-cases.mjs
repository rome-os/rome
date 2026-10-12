#!/usr/bin/env node
// Secret- and browser-free validation: load the Midscene project config,
// discover every workflow YAML, and run the same collection the runner uses
// (YAML parse, schema/unknown-key checks, custom-node resolution) without
// launching Chromium or calling the model. The pull_request CI job runs this
// so a malformed case or a broken node reference fails before merge.

import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { collectWorkflowDocument } from "@midscene/test";
import {
  DEFAULT_TEST_FILE_SELECTION,
  discoverTestFiles,
  loadTestProject,
} from "@midscene/test/config";

const projectRoot = process.cwd();
const configPath = resolve(projectRoot, "midscene.config.ts");
const expectedCases = JSON.parse(
  await readFile(resolve(projectRoot, "case-manifest.json"), "utf8"),
);
const collectedCases = new Map();

const loaded = await loadTestProject(configPath);

let fileCount = 0;
let caseCount = 0;
const failures = [];
const atomicAiNode = /^ai(?:Tap|Scroll|Input|Hover|Keyboard)/;
const infrastructureNodes = new Set(["app.open", "app.expectRenameConflict"]);
const validateAiNativeCase = (testCase) => {
  const nodes = testCase.definition.steps.map((step) => step.node);
  const tags = new Set(testCase.definition.tags);
  const problems = [];

  if (nodes[0] !== "app.open") problems.push("the first step must be app.open");
  if (nodes.filter((node) => node === "app.open").length !== 1) {
    problems.push("each case must have exactly one app.open");
  }
  if (!nodes.includes("aiAct")) problems.push("at least one aiAct is required");
  if (!nodes.includes("aiAssert")) problems.push("at least one aiAssert is required");
  if (collectedCases.has(testCase.definition.name)) problems.push("duplicate case name");
  collectedCases.set(testCase.definition.name, true);

  const forbidden = nodes.filter(
    (node) =>
      atomicAiNode.test(node) || (node.startsWith("app.") && !infrastructureNodes.has(node)),
  );
  if (forbidden.length > 0) {
    problems.push(`use aiAct instead of ${[...new Set(forbidden)].join(", ")}`);
  }
  if (tags.has("deterministic-assist")) problems.push("remove the deterministic-assist tag");

  if (problems.length > 0) {
    throw new Error(`${testCase.definition.name}: ${problems.join("; ")}`);
  }
};

for (const project of loaded.projects) {
  const selection = project.files ?? DEFAULT_TEST_FILE_SELECTION;
  const files = discoverTestFiles(projectRoot, selection);
  console.log(`Project "${project.name}": ${files.length} workflow file(s)`);

  for (const absolutePath of files) {
    fileCount += 1;
    const sourcePath = relative(projectRoot, absolutePath).split(sep).join("/");
    try {
      const document = collectWorkflowDocument(
        {
          projectId: project.projectId,
          projectName: project.name,
          sourcePath,
          absolutePath,
        },
        {
          resolveNode: project.nodes.get.bind(project.nodes),
          variables: project.variables,
          env: process.env,
        },
      );
      for (const testCase of document.cases) validateAiNativeCase(testCase);
      caseCount += document.cases.length;
    } catch (error) {
      failures.push({ sourcePath, error });
    }
  }
}

for (const { sourcePath, error } of failures) {
  console.error(`x ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`);
}

if (failures.length > 0) {
  console.error(`\nCollection failed: ${failures.length} invalid workflow file(s).`);
  process.exit(1);
}

const expectedNames = expectedCases;
const unexpectedNames = [...collectedCases.keys()].filter((name) => !expectedNames.includes(name));
const missingNames = expectedNames.filter((name) => !collectedCases.has(name));
const catalog = await readFile(resolve(projectRoot, "../../docs/midscene-e2e-cases.md"), "utf8");
const catalogCases = new Map();
for (const match of catalog.matchAll(/^\| ([A-Z0-9]+-\d+) \| (.+) \|$/gm)) {
  if (catalogCases.has(match[1])) throw new Error(`Duplicate catalog ID: ${match[1]}`);
  catalogCases.set(match[1], { name: `${match[1]} ${match[2]}` });
}
const catalogMismatch = expectedNames.filter((name) => {
  const id = name.split(" ")[0];
  const row = catalogCases.get(id);
  return !row || row.name !== name;
});
if (
  unexpectedNames.length ||
  missingNames.length ||
  catalogMismatch.length ||
  catalogCases.size !== expectedNames.length
) {
  console.error("Case manifest or catalog differs from the executable YAML cases.");
  for (const [label, names] of Object.entries({
    unexpectedNames,
    missingNames,
    catalogMismatch,
  })) {
    if (names.length) console.error(`${label}: ${names.join(", ")}`);
  }
  process.exit(1);
}

console.log(
  `Collection OK: ${caseCount} cases in ${fileCount} file(s) across ${loaded.projects.length} project(s).`,
);
