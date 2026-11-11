import assert from "node:assert/strict";
import { test } from "node:test";
import { changesImage, entryOf, releaseNotes } from "./release-notes.mjs";

const release = (commits, previousTag = "v1.1.190") =>
  releaseNotes({
    tag: "v1.1.191",
    previousTag,
    sha: "a5a06bd9765f91ac82c0418a8f30bc2d8deefd43",
    image: "yunfanye/rome",
    repository: "rome-os/rome",
    commits,
  });

test("a commit changes the image unless every file it touches ships elsewhere", () => {
  assert.equal(changesImage(["packages/core/src/index.ts"]), true);
  assert.equal(changesImage(["ios/Rome/App.swift", "packages/web/src/main.tsx"]), true);
  assert.equal(changesImage(["ios/Rome/App.swift"]), false);
  assert.equal(changesImage(["packages/desktop/main.ts", "docs/releases.md"]), false);
  assert.equal(changesImage([".github/workflows/ci.yml", "README.md"]), false);
  assert.equal(changesImage(["Dockerfile"]), true);
  assert.equal(changesImage(["rome_apps/notes/README.md"]), true);
});

test("a subject's type picks its section, and its scope leads the line", () => {
  assert.deepEqual(entryOf("feat(web): a thing (#1)"), {
    section: "new",
    line: "**web:** a thing (#1)",
  });
  assert.equal(entryOf("fix: a bug").section, "fixes");
  assert.equal(entryOf("perf(core): faster").section, "fixes");
  assert.equal(entryOf("feat(core)!: drop a route").section, "breaking");
  assert.equal(entryOf("refactor(core): move code").section, "internal");
  assert.deepEqual(entryOf("Update things"), { section: "other", line: "Update things" });
});

test("the notes group the image's changes and leave out what ships elsewhere", () => {
  const notes = release([
    { subject: "feat(ui): typography (#1983)", files: ["packages/ui/src/a.css"] },
    { subject: "refactor(core): split (#1992)", files: ["packages/core/src/a.ts"] },
    { subject: "feat(ios): iPad support (#1971)", files: ["ios/Rome/A.swift"] },
    { subject: "ci(desktop): releases (#1974)", files: [".github/workflows/d.yml"] },
    { subject: "chore: release main", files: ["packages/ui/package.json"] },
    { subject: "fix(concierge): fresh waits (#1964)", files: ["packages/core/src/b.ts"] },
  ]);
  assert.equal(
    notes,
    [
      "The Rome runtime image `yunfanye/rome:1.1.191`, built from a5a06bd. Rome Cloud offers it to instances on its own. To run it yourself, pull `yunfanye/rome:1.1.191`.",
      "",
      "## Changes since v1.1.190",
      "",
      "### New",
      "",
      "- **ui:** typography (#1983)",
      "",
      "### Fixes",
      "",
      "- **concierge:** fresh waits (#1964)",
      "",
      "<details>",
      "<summary>Internal changes (1)</summary>",
      "",
      "- **core:** split (#1992)",
      "",
      "</details>",
      "",
      "**Full changelog:** https://github.com/rome-os/rome/compare/v1.1.190...v1.1.191",
      "",
    ].join("\n"),
  );
});

test("a release with nothing for the image says so", () => {
  const notes = release([{ subject: "docs: a page", files: ["docs/a.md"] }]);
  assert.match(notes, /No changes to the image\./);
  assert.doesNotMatch(notes, /###/);
});

test("without a previous release the notes list no changes", () => {
  const notes = release([], null);
  assert.doesNotMatch(notes, /Changes since|Full changelog/);
});
