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
  env.GREEN_SHAS = sha;
  git("remote", "add", "origin", remote);
  git("tag", "v1.1.9");
  git("push", "origin", "main", "--tags");
  writeFileSync(
    join(bin, "gh"),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$GH_CALLS"\nif [ "$GREEN_SHAS" = api-error ]; then exit 1; fi\nprintf "%s\\n" "$GREEN_SHAS"\n',
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
    /branch=main&event=push&status=success&per_page=100/,
  );
});

test("a manual run on main allocates the next patch like the schedule", (t) => {
  const f = fixture(t);
  const result = f.run({ GITHUB_EVENT_NAME: "workflow_dispatch" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.output(), `tag=v1.1.10\nsha=${f.sha}\n`);
  assert.equal(f.git("--git-dir", f.remote, "rev-parse", "v1.1.10^{commit}"), f.sha);
});

test("stable versions sort numerically across minor and major versions", (t) => {
  const f = fixture(t);
  for (const tag of ["v2.9.9", "v2.10.12", "v1.99.99", "v3.0.0-rc.1"]) f.git("tag", tag);
  assert.equal(f.run().status, 0);
  assert.match(f.output(), /^tag=v2\.10\.13\n/);
});

for (const [name, green] of [
  ["no green commit", ""],
  ["an API error", "api-error"],
  ["a green commit outside this history", "0".repeat(40)],
]) {
  test(`${name} creates no release tag`, (t) => {
    const f = fixture(t);
    assert.notEqual(f.run({ GREEN_SHAS: green }).status, 0);
    assert.equal(f.git("tag", "--list"), "v1.1.9");
    assert.equal(f.git("ls-remote", "--tags", "origin", "v1.1.10"), "");
    assert.equal(f.output(), "");
  });
}

// main moves on from the tagged commit: one commit passes CI, the newest has not.
function unfinishedHead(f) {
  f.git("commit", "--allow-empty", "-m", "Passed CI");
  const green = f.git("rev-parse", "HEAD");
  f.git("commit", "--allow-empty", "-m", "Not passed CI");
  const head = f.git("rev-parse", "HEAD");
  f.git("push", "origin", "main");
  return { green, head };
}

test("a newest commit that has not passed CI releases the newest green commit and says so", (t) => {
  const f = fixture(t);
  const { green, head } = unfinishedHead(f);
  const result = f.run({ GITHUB_SHA: head, GREEN_SHAS: `${green}\n${f.sha}` });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.output(), `tag=v1.1.10\nsha=${green}\n`);
  assert.equal(f.git("--git-dir", f.remote, "rev-parse", "v1.1.10^{commit}"), green);
  assert.match(result.stdout, new RegExp(`::warning::v1\\.1\\.10 releases ${green}.*${head}`));
});

test("a commit that went green after the run started is not released", (t) => {
  const f = fixture(t);
  const { green, head } = unfinishedHead(f);
  f.git("checkout", "--detach", green);
  const result = f.run({ GITHUB_SHA: green, GREEN_SHAS: `${head}\n${green}` });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.output(), `tag=v1.1.10\nsha=${green}\n`);
  assert.doesNotMatch(result.stdout, /::warning::/);
});

test("a rerun of a release from an older green commit keeps its version and commit", (t) => {
  const f = fixture(t);
  const { green, head } = unfinishedHead(f);
  assert.equal(f.run({ GITHUB_SHA: head, GREEN_SHAS: green }).status, 0);
  const result = f.run({ GITHUB_SHA: head, GREEN_SHAS: "api-error" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.output(), `tag=v1.1.10\nsha=${green}\n`);
});

test("a newest green commit that is already released creates no release tag", (t) => {
  const f = fixture(t);
  const { head } = unfinishedHead(f);
  assert.notEqual(f.run({ GITHUB_SHA: head, GREEN_SHAS: f.sha }).status, 0);
  assert.equal(f.git("tag", "--list"), "v1.1.9");
  assert.equal(f.output(), "");
});

test("a manual run does not fall back from a commit that has not passed CI", (t) => {
  const f = fixture(t);
  const { green, head } = unfinishedHead(f);
  const result = f.run({
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_SHA: head,
    GREEN_SHAS: green,
  });
  assert.notEqual(result.status, 0);
  assert.equal(f.git("tag", "--list"), "v1.1.9");
  assert.equal(f.output(), "");
});

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
    GREEN_SHAS: "api-error",
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
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_EVENT_NAME: "push" },
    { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/feature" },
    { GITHUB_REF: "refs/heads/feature" },
    { GITHUB_SHA: "0".repeat(40) },
  ]) {
    assert.notEqual(f.run(overrides).status, 0);
    assert.equal(f.git("tag", "--list"), "v1.1.9");
    assert.equal(f.output(), "");
  }
});
