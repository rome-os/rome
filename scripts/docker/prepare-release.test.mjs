import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./prepare-release.sh", import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "rome-release-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "checkout");
  const remote = join(root, "remote.git");
  const bin = join(root, "bin");
  mkdirSync(cwd);
  mkdirSync(bin);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GITHUB_EVENT_NAME: "schedule",
    GITHUB_REF: "refs/heads/main",
    GITHUB_RUN_ID: "100",
    GITHUB_REPOSITORY: "rome-os/rome",
    GITHUB_OUTPUT: join(root, "output"),
    CI_RESULT: "completed:success",
    GH_CALLS: join(root, "gh-calls"),
  };
  const git = (...args) =>
    execFileSync("git", args, {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "--bare", remote);
  git("init", "-b", "main");
  git("config", "user.name", "Release test");
  git("config", "user.email", "release@example.invalid");
  git("commit", "--allow-empty", "-m", "Initial commit");
  const sha = git("rev-parse", "HEAD");
  env.GITHUB_SHA = sha;
  git("remote", "add", "origin", remote);
  git("tag", "v1.1.9");
  git("push", "origin", "main", "--tags");
  writeFileSync(
    join(bin, "gh"),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$GH_CALLS"\nif [ "$CI_RESULT" = api-error ]; then exit 1; fi\nprintf "%s\\n" "$CI_RESULT"\n',
    { mode: 0o755 },
  );

  const run = (overrides = {}) => {
    writeFileSync(env.GITHUB_OUTPUT, "");
    return spawnSync("bash", [script], { cwd, env: { ...env, ...overrides }, encoding: "utf8" });
  };
  const output = () => readFileSync(env.GITHUB_OUTPUT, "utf8");
  return { git, run, output, sha, env, remote };
}

test("a weekday release increments the stable patch and pins the checked CI commit", (t) => {
  const f = fixture(t);
  for (const tag of ["v1.1.8", "v1.2.0-rc.1", "desktop-v9.0.0", "v01.99.0"]) {
    f.git("tag", tag);
  }
  f.git("commit", "--allow-empty", "-m", "A newer main commit");
  f.git("push", "origin", "main");
  f.git("checkout", "--detach", f.sha);

  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.output(), `tag=v1.1.10\nsha=${f.sha}\n`);
  assert.equal(f.git("--git-dir", f.remote, "rev-parse", "v1.1.10^{commit}"), f.sha);
  assert.match(
    readFileSync(f.env.GH_CALLS, "utf8"),
    new RegExp(`branch=main&event=push&head_sha=${f.sha}&per_page=1`),
  );
});

test("stable versions sort numerically across minor and major versions", (t) => {
  const f = fixture(t);
  for (const tag of ["v2.9.9", "v2.10.12", "v1.99.99", "v3.0.0-rc.1"]) f.git("tag", tag);
  assert.equal(f.run().status, 0);
  assert.match(f.output(), /^tag=v2\.10\.13\n/);
});

for (const ci of [
  "null:null",
  "completed:failure",
  "completed:cancelled",
  "in_progress:null",
  "queued:null",
  "api-error",
]) {
  test(`CI ${ci} creates no release tag`, (t) => {
    const f = fixture(t);
    assert.notEqual(f.run({ CI_RESULT: ci }).status, 0);
    assert.equal(f.git("tag", "--list"), "v1.1.9");
    assert.equal(f.git("ls-remote", "--tags", "origin", "v1.1.10"), "");
    assert.equal(f.output(), "");
  });
}

test("a rerun reuses its tag after another release, and a new run still increments without new commits", (t) => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  f.git("tag", "v1.1.11");
  f.git("push", "origin", "v1.1.11");
  assert.equal(f.run().status, 0);
  assert.match(f.output(), /^tag=v1\.1\.10\n/);
  assert.equal(f.git("tag", "--list", "v1.1.12"), "");

  assert.equal(f.run({ GITHUB_RUN_ID: "101" }).status, 0);
  assert.match(f.output(), /^tag=v1\.1\.12\n/);
});

test("tag pushes retain their version without allocating a patch or querying CI", (t) => {
  const f = fixture(t);
  const result = f.run({
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/tags/v2.0.0-rc.1",
    CI_RESULT: "api-error",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.output(), `tag=v2.0.0-rc.1\nsha=${f.sha}\n`);
  assert.equal(f.git("tag", "--list"), "v1.1.9");
});

test("a remote tag collision fails without overwriting the existing tag", (t) => {
  const f = fixture(t);
  f.git("tag", "v1.1.10");
  f.git("push", "origin", "v1.1.10");
  f.git("tag", "-d", "v1.1.10");
  assert.notEqual(f.run().status, 0);
  assert.equal(f.git("--git-dir", f.remote, "rev-parse", "v1.1.10"), f.sha);
  assert.equal(f.output(), "");
});

test("missing stable versions fail without inventing an initial version", (t) => {
  const f = fixture(t);
  f.git("tag", "-d", "v1.1.9");
  assert.notEqual(f.run().status, 0);
  assert.equal(f.git("tag", "--list"), "");
});

test("unexpected events, branches, and checkout commits cannot allocate a version", (t) => {
  const f = fixture(t);
  for (const overrides of [
    { GITHUB_EVENT_NAME: "workflow_dispatch" },
    { GITHUB_EVENT_NAME: "push" },
    { GITHUB_REF: "refs/heads/feature" },
    { GITHUB_SHA: "0".repeat(40) },
  ]) {
    assert.notEqual(f.run(overrides).status, 0);
    assert.equal(f.git("tag", "--list"), "v1.1.9");
    assert.equal(f.output(), "");
  }
});
