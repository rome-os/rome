import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  GATE_PATH,
  PENDING_PATH,
  compareVersions,
  latestReleaseTag,
  plan,
  readMinimums,
  run,
  validatePending,
  writeMinimums,
} from "./bump-minimum.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("versions", () => {
  it("compares release numbers by part, with or without the v", () => {
    assert.ok(compareVersions("1.1.10", "1.1.9") > 0);
    assert.ok(compareVersions("v1.1.196", "1.1.204") < 0);
    assert.equal(compareVersions("v1.2.0", "1.2.0"), 0);
    assert.ok(compareVersions("2.0.0", "1.99.99") > 0);
    assert.throws(() => compareVersions("dev", "1.1.1"));
  });

  it("picks the highest v1 release tag, not the last in text order", () => {
    assert.equal(
      latestReleaseTag(["v1.1.99", "v1.1.204", "v1.1.3", "rome-ui-v1.2.0", "v1.1.205-rc.1"]),
      "v1.1.204",
    );
    assert.equal(latestReleaseTag(["rome-ui-v1.2.0"]), null);
  });
});

describe("pending file", () => {
  it("accepts the committed file", () => {
    const pending = JSON.parse(readFileSync(join(repoRoot, PENDING_PATH), "utf8"));
    assert.deepEqual(validatePending(pending), []);
  });

  it("names each malformed field", () => {
    const errors = validatePending({
      entries: [{ tier: "soon", reason: "", pr: "12", server: "main", extra: 1 }],
    });
    assert.equal(errors.length, 5);
    assert.deepEqual(validatePending({}), ['expected an object with an "entries" array']);
    assert.deepEqual(
      validatePending({ entries: [{ tier: "blocking", reason: "x", pr: 1, server: "#2" }] }),
      [],
    );
  });
});

describe("plan", () => {
  const current = { blocking: "1.1.196", background: "1.1.200" };
  const entry = (tier, server = "#1") => ({ tier, reason: "r", pr: 9, server });

  it("raises the background minimum only, for background entries", () => {
    const result = plan({
      entries: [entry("background")],
      release: "v1.1.204",
      current,
      contains: () => true,
    });
    assert.deepEqual(result.next, { blocking: "1.1.196", background: "1.1.204" });
  });

  it("raises both for a blocking entry", () => {
    const result = plan({
      entries: [entry("background"), entry("blocking")],
      release: "v1.1.204",
      current,
      contains: () => true,
    });
    assert.deepEqual(result.next, { blocking: "1.1.204", background: "1.1.204" });
  });

  it("never lowers a minimum", () => {
    const result = plan({
      entries: [entry("blocking")],
      release: "v1.1.198",
      current,
      contains: () => true,
    });
    assert.deepEqual(result.next, { blocking: "1.1.198", background: "1.1.200" });
  });

  it("stops when the release lacks a server change", () => {
    const result = plan({
      entries: [entry("background", "#7")],
      release: "v1.1.204",
      current,
      contains: () => false,
    });
    assert.match(result.stop, /^Release the server first: v1\.1\.204 does not contain #7/);
  });

  it("does nothing with no entries", () => {
    assert.equal(
      plan({ entries: [], release: "v1.1.204", current, contains: () => true }).unchanged,
      true,
    );
  });

  it("reads and writes the Swift constants", () => {
    const swift = readFileSync(join(repoRoot, GATE_PATH), "utf8");
    const minimums = readMinimums(swift);
    const written = writeMinimums(swift, { blocking: "9.9.8", background: "9.9.9" });
    assert.deepEqual(readMinimums(written), { blocking: "9.9.8", background: "9.9.9" });
    assert.deepEqual(readMinimums(writeMinimums(written, minimums)), minimums);
  });
});

describe("run, in a scratch repository", () => {
  function scratch() {
    const repo = mkdtempSync(join(tmpdir(), "rome-bump-minimum-"));
    const git = (...args) =>
      execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "test");
    mkdirSync(join(repo, dirname(GATE_PATH)), { recursive: true });
    mkdirSync(join(repo, dirname(PENDING_PATH)), { recursive: true });
    writeFileSync(
      join(repo, GATE_PATH),
      'static let blockingMinimumInstanceVersion = "1.1.196"\nstatic let minimumInstanceVersion = "1.1.196"\n',
    );
    writeFileSync(join(repo, PENDING_PATH), '{ "entries": [] }\n');
    git("add", ".");
    git("commit", "-q", "-m", "base");
    git("tag", "v1.1.200");
    git("commit", "-q", "--allow-empty", "-m", "feat(core): add the outputs API (#2340)");
    return { repo, git };
  }

  it("stops before the server change is released, then raises once it is", () => {
    const { repo, git } = scratch();
    try {
      const pending = {
        entries: [{ tier: "background", reason: "Outputs tab", pr: 2351, server: "#2340" }],
      };
      writeFileSync(join(repo, PENDING_PATH), JSON.stringify(pending));
      const quiet = () => {};

      const stopped = run({ repo, fetch: false, log: quiet });
      assert.equal(stopped.code, 1);
      assert.match(stopped.message, /Release the server first: v1\.1\.200 does not contain #2340/);
      assert.deepEqual(readMinimums(readFileSync(join(repo, GATE_PATH), "utf8")), {
        blocking: "1.1.196",
        background: "1.1.196",
      });

      git("tag", "v1.1.201");
      const raised = run({ repo, fetch: false, log: quiet });
      assert.equal(raised.code, 0, raised.message);
      assert.deepEqual(readMinimums(readFileSync(join(repo, GATE_PATH), "utf8")), {
        blocking: "1.1.196",
        background: "1.1.201",
      });
      assert.deepEqual(JSON.parse(readFileSync(join(repo, PENDING_PATH), "utf8")), { entries: [] });
      // Edits only: nothing is committed.
      assert.notEqual(git("status", "--porcelain"), "");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("stops on a server change it cannot find", () => {
    const { repo } = scratch();
    try {
      const pending = { entries: [{ tier: "blocking", reason: "x", pr: 1, server: "#9999" }] };
      writeFileSync(join(repo, PENDING_PATH), JSON.stringify(pending));
      const result = run({ repo, fetch: false, log: () => {} });
      assert.equal(result.code, 1);
      assert.match(result.message, /#9999 \(no commit on any fetched branch mentions it\)/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
