import assert from "node:assert/strict";
import test from "node:test";
import { diffAgainstBaseline, renderBaseline, tally } from "./check-prose.mjs";

// Vale's own output, trimmed to the fields the script reads. The tests run
// without vale on PATH, so the parsing and the verdict are covered here and the
// binary is exercised by `pnpm lint:docs` in CI.
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
