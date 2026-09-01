import assert from "node:assert/strict";
import test from "node:test";
import { PASSES, diffAgainstBaseline, passFiles, renderBaseline, tally } from "./check-prose.mjs";

// Vale's own output, trimmed to the fields the script reads. The tests run
// without vale on PATH, so the parsing and the verdict are covered here and the
// binary is exercised by `pnpm lint:prose` in CI.
const report = {
  "docs/a.md": [
    { Check: "Rome.Semicolons", Severity: "error", Match: ";", Line: 3 },
    { Check: "Rome.Semicolons", Severity: "error", Match: ";", Line: 9 },
    { Check: "Rome.WordChoice", Severity: "error", Match: "utilize", Line: 4 },
  ],
  "docs/b.md": [{ Check: "Rome.PlainLanguage", Severity: "suggestion", Match: "assist", Line: 1 }],
};

test("counts errors per file and per rule", () => {
  assert.deepEqual(tally(report), {
    "docs/a.md": { "Rome.Semicolons": 2, "Rome.WordChoice": 1 },
  });
});

test("a suggestion is not a violation", () => {
  // Rome.PlainLanguage advises on word choice and must never gate a build, so
  // docs/b.md carries no entry at all.
  assert.equal(tally(report)["docs/b.md"], undefined);
});

test("prose matching the baseline passes", () => {
  const { added, fixed } = diffAgainstBaseline(tally(report), {
    "docs/a.md": { "Rome.Semicolons": 2, "Rome.WordChoice": 1 },
  });
  assert.deepEqual(added, []);
  assert.deepEqual(fixed, []);
});

test("a new violation in a baselined file fails", () => {
  const { added } = diffAgainstBaseline(tally(report), {
    "docs/a.md": { "Rome.Semicolons": 1, "Rome.WordChoice": 1 },
  });
  assert.deepEqual(
    added.map((a) => `${a.file} ${a.rule} ${a.beforeCount}->${a.nowCount}`),
    ["docs/a.md Rome.Semicolons 1->2"],
  );
});

test("a violation in a file the baseline does not list fails", () => {
  const { added } = diffAgainstBaseline(tally(report), {});
  assert.deepEqual(
    added.map((a) => a.rule),
    ["Rome.Semicolons", "Rome.WordChoice"],
  );
});

test("a baseline entry that has been fixed fails, so the list cannot outlive the debt", () => {
  const { fixed } = diffAgainstBaseline(tally(report), {
    "docs/a.md": { "Rome.Semicolons": 2, "Rome.WordChoice": 1 },
    "docs/gone.md": { "Rome.Contractions": 4 },
  });
  assert.deepEqual(
    fixed.map((f) => `${f.file} ${f.rule} ${f.beforeCount}->${f.nowCount}`),
    ["docs/gone.md Rome.Contractions 4->0"],
  );
});

test("the rendered baseline is a module that round-trips", async () => {
  const counts = tally(report);
  const source = renderBaseline(counts);
  const { BASELINE } = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  assert.deepEqual(BASELINE, counts);
});

// The file list comes from git rather than a hard-coded set of directories, so
// what these assert is coverage, not a roster: a gate that reaches no files
// reports success over prose nobody checked.
test("the docs pass reaches every tracked doc", () => {
  const files = passFiles(PASSES.find((p) => p.name === "docs").pathspecs);
  assert.ok(files.length > 50, `expected the docs tree, found ${files.length} files`);
  assert.ok(files.every((f) => f.startsWith("docs/") && f.endsWith(".md")));
});

test("the sources pass reaches tracked TypeScript outside packages/", () => {
  const files = passFiles(PASSES.find((p) => p.name === "sources").pathspecs);
  assert.ok(files.length > 1000, `expected the source trees, found ${files.length} files`);

  // One root per line of defence that a directory-list version of this would
  // have had to name by hand. `scripts/` shipped a real violation the gate
  // missed while the list was ["packages", "rome_apps"].
  for (const root of ["packages/", "rome_apps/", "scripts/", "example_apps/", ".claude/"]) {
    assert.ok(
      files.some((f) => f.startsWith(root)),
      `no tracked source found under ${root}`,
    );
  }
});

test("the sources pass excludes generated output", () => {
  const files = passFiles(PASSES.find((p) => p.name === "sources").pathspecs);
  assert.ok(!files.some((f) => f.includes("/dist/") || f.includes("/node_modules/")));
});
