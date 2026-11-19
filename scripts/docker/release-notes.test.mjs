import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  changesImage,
  entryOf,
  lineOf,
  previousRelease,
  releaseNotes,
  releaseNotesJson,
} from "./release-notes.mjs";
import { sourceDirs } from "./runtime-inputs.mjs";

const script = fileURLToPath(new URL("./release-notes.mjs", import.meta.url));

const release = (commits, previousTag = "v1.1.190") =>
  releaseNotes({
    tag: "v1.1.191",
    previousTag,
    sha: "a5a06bd9765f91ac82c0418a8f30bc2d8deefd43",
    image: "yunfanye/rome",
    repository: "rome-os/rome",
    commits,
  });

test("a commit changes the image when it touches a file the image is built from", () => {
  assert.equal(changesImage(["packages/core/src/index.ts"]), true);
  assert.equal(changesImage(["ios/Rome/App.swift", "packages/web/src/main.tsx"]), true);
  assert.equal(changesImage(["Dockerfile"]), true);
  assert.equal(changesImage(["pnpm-workspace.yaml"]), true);
  assert.equal(changesImage(["rome_apps/notes/README.md"]), true);
  assert.equal(changesImage(["infra/chrome/policy.json"]), true);
  assert.equal(changesImage(["scripts/docker/prepare-release.sh"]), true);
  // Never copied into the build context.
  assert.equal(changesImage(["ios/Rome/App.swift"]), false);
  assert.equal(changesImage(["packages/desktop/main.ts"]), false);
  assert.equal(changesImage(["packages/host-helper/src/a.ts"]), false);
  assert.equal(changesImage(["lint/rules/contexts.ts"]), false);
  assert.equal(changesImage(["tests/e2e/a.ts", "scripts/imports-of.mjs"]), false);
  assert.equal(changesImage(["infra/terraform/main.tf", ".github/workflows/ci.yml"]), false);
  assert.equal(changesImage(["README.md", "biome.json"]), false);
  // Copied, then dropped on the way in.
  assert.equal(changesImage(["packages/core/src/a.test.ts"]), false);
  // Shipped docs alone change no behavior.
  assert.equal(changesImage(["docs/concepts/agents.md", "ios/Rome/A.swift"]), false);
  assert.equal(changesImage(["docs/concepts/agents.md", "packages/core/src/a.ts"]), true);
});

test("every directory the prepare script copies is a runtime input", () => {
  const prepare = readFileSync(new URL("./prepare-runtime-workspace.mjs", import.meta.url), "utf8");
  const copied = [...prepare.matchAll(/copyPath\("([^"]+)"\)/g)].map((match) => match[1]);
  assert.deepEqual(copied.sort(), [...sourceDirs].sort());
});

test("the notes count from the highest published stable version below the release", () => {
  const published = ["latest", "1.1.189", "1.1.190", "1.1.191", "1.2.0-rc.1", "1.1.10"];
  assert.equal(previousRelease("1.1.191", published), "1.1.190");
  assert.equal(previousRelease("1.1.192", published), "1.1.191");
  // A tag whose build never shipped: its changes roll into the next one.
  assert.equal(previousRelease("1.1.193", published), "1.1.191");
  // A backport counts from the version before it, not the newest.
  assert.equal(previousRelease("1.1.11", published), "1.1.10");
  // A prerelease counts from the stable before its own version.
  assert.equal(previousRelease("1.2.0-rc.2", published), "1.1.191");
  assert.equal(previousRelease("1.2.0", published), "1.1.191");
  assert.equal(previousRelease("1.0.0", published), null);
});

test("a subject's type picks its section, and its scope leads the line", () => {
  assert.deepEqual(entryOf("feat(web): a thing (#1)"), {
    section: "new",
    scope: "web",
    text: "a thing",
    pr: 1,
  });
  assert.equal(lineOf(entryOf("feat(web): a thing (#1)")), "**web:** a thing (#1)");
  assert.deepEqual(entryOf("fix: a bug (#12) in (#3) parsing"), {
    section: "fixes",
    scope: null,
    text: "a bug (#12) in (#3) parsing",
    pr: null,
  });
  assert.equal(entryOf("fix: a bug").section, "fixes");
  assert.equal(entryOf("perf(core): faster").section, "fixes");
  assert.equal(entryOf("feat(core)!: drop a route").section, "breaking");
  assert.equal(entryOf("refactor(core): move code").section, "internal");
  assert.deepEqual(entryOf("Update things (#7)"), {
    section: "other",
    scope: null,
    text: "Update things",
    pr: 7,
  });
  assert.equal(lineOf(entryOf("Update things (#7)")), "Update things (#7)");
  assert.equal(
    entryOf("refactor(core): drop a route", "Why.\n\nBREAKING CHANGE: gone").section,
    "breaking",
  );
  assert.equal(entryOf("feat: a thing", "Mentions a BREAKING CHANGE: inline").section, "new");
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

test("the JSON lists the same changes by section, with internal ones as a count", () => {
  const notes = releaseNotesJson({
    tag: "v1.1.191",
    previousTag: "v1.1.190",
    date: "2026-11-19T00:10:13.000Z",
    repository: "rome-os/rome",
    commits: [
      { subject: "feat(ui): typography (#1983)", files: ["packages/ui/src/a.css"] },
      { subject: "refactor(core): split (#1992)", files: ["packages/core/src/a.ts"] },
      { subject: "feat(ios): iPad support (#1971)", files: ["ios/Rome/A.swift"] },
      { subject: "chore: release main", files: ["packages/ui/package.json"] },
      { subject: "fix(concierge): fresh waits (#1964)", files: ["packages/core/src/b.ts"] },
      { subject: "fix: a direct push", files: ["packages/core/src/c.ts"] },
      { subject: "Update things", files: ["packages/core/src/d.ts"] },
      {
        subject: "refactor(core)!: drop a route (#1950)",
        body: "",
        files: ["packages/core/src/e.ts"],
      },
    ],
  });
  assert.deepEqual(notes, {
    schema: 2,
    version: "1.1.191",
    previousVersion: "1.1.190",
    date: "2026-11-19T00:10:13.000Z",
    url: "https://github.com/rome-os/rome/releases/tag/v1.1.191",
    breaking: [{ scope: "core", text: "drop a route", pr: 1950 }],
    new: [{ scope: "ui", text: "typography", pr: 1983 }],
    fixes: [
      { scope: "concierge", text: "fresh waits", pr: 1964 },
      { scope: null, text: "a direct push", pr: null },
    ],
    internal: 2,
    highlights: { en: [], zh: [] },
  });
});

test("the JSON for a first release or one with nothing for the image lists nothing", () => {
  const empty = { breaking: [], new: [], fixes: [], internal: 0, highlights: { en: [], zh: [] } };
  const first = releaseNotesJson({
    tag: "v1.0.0",
    previousTag: null,
    date: "2026-01-01T00:00:00.000Z",
    repository: "rome-os/rome",
    commits: [{ subject: "feat: ignored", files: ["Dockerfile"] }],
  });
  assert.deepEqual(first, {
    schema: 2,
    version: "1.0.0",
    previousVersion: null,
    date: "2026-01-01T00:00:00.000Z",
    url: "https://github.com/rome-os/rome/releases/tag/v1.0.0",
    ...empty,
  });
  const quiet = releaseNotesJson({
    tag: "v1.0.1",
    previousTag: "v1.0.0",
    date: "2026-01-02T00:00:00.000Z",
    repository: "rome-os/rome",
    commits: [{ subject: "docs: a page", files: ["docs/a.md"] }],
  });
  assert.equal(quiet.previousVersion, "1.0.0");
  assert.deepEqual([quiet.breaking, quiet.new, quiet.fixes, quiet.internal], [[], [], [], 0]);
});

test("a release with nothing for the image says so", () => {
  const notes = release([{ subject: "docs: a page", files: ["docs/a.md"] }]);
  assert.match(notes, /No changes to what the image runs\./);
  assert.doesNotMatch(notes, /###/);
});

test("without a previous release the notes list no changes", () => {
  const notes = release([], null);
  assert.doesNotMatch(notes, /Changes since|Full changelog/);
});

test("the script reads the range from git, footers included", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rome-release-notes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    IMAGE_NAME: "yunfanye/rome",
    GITHUB_REPOSITORY: "rome-os/rome",
  };
  const git = (...args) => execFileSync("git", args, { cwd: root, env, encoding: "utf8" });
  const commit = (file, message) => {
    writeFileSync(join(root, file), file);
    git("add", "-A");
    git("commit", "-q", "-m", message);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Release test");
  git("config", "user.email", "release@example.invalid");
  commit("Dockerfile", "chore: initial");
  git("tag", "v1.0.0");
  commit("package.json", "refactor(core): drop a route\n\nBREAKING CHANGE: the route is gone");
  git("tag", "v1.0.1");
  commit("Caddyfile", "fix(core): never shipped");
  git("tag", "v1.0.2");
  commit("README.md", "docs: readme");
  git("tag", "v1.0.3");
  writeFileSync(join(root, "published.txt"), "latest\n1.0.0\n1.0.1\n");

  const notes = execFileSync(
    "node",
    [script, "v1.0.3", "published.txt", "--json", "release-notes.json"],
    { cwd: root, env, encoding: "utf8" },
  );
  assert.match(notes, /## Changes since v1\.0\.1/);
  const json = JSON.parse(readFileSync(join(root, "release-notes.json"), "utf8"));
  assert.equal(json.version, "1.0.3");
  assert.equal(json.previousVersion, "1.0.1");
  assert.ok(!Number.isNaN(Date.parse(json.date)));
  assert.deepEqual(json.fixes, [{ scope: "core", text: "never shipped", pr: null }]);
  assert.match(notes, /### Fixes\n\n- \*\*core:\*\* never shipped/);
  assert.doesNotMatch(notes, /readme/);

  const first = execFileSync("node", [script, "v1.0.1", "published.txt"], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  assert.match(first, /### Breaking changes\n\n- \*\*core:\*\* drop a route/);
});
