// Run: node --test environments/slack-app/tools/resolve-ref.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const tool = fileURLToPath(new URL("resolve-ref.sh", import.meta.url));
const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

test("an origin/ branch resolves in a shallow single-branch clone", () => {
  const dir = mkdtempSync(join(tmpdir(), "resolve-ref-"));
  const origin = join(dir, "origin");
  git(dir, "init", "-q", "-b", "main", origin);
  git(origin, "commit", "-q", "--allow-empty", "-m", "main");
  git(origin, "checkout", "-q", "-b", "product");
  git(origin, "commit", "-q", "--allow-empty", "-m", "product");
  const product = git(origin, "rev-parse", "HEAD");
  git(origin, "checkout", "-q", "main");
  const clone = join(dir, "clone");
  git(
    dir,
    "clone",
    "-q",
    "--depth",
    "1",
    "--single-branch",
    "-b",
    "main",
    `file://${origin}`,
    clone,
  );
  const out = execFileSync(tool, [clone, "origin/product"], { encoding: "utf8" }).trim();
  assert.equal(out, product);
  assert.throws(() => execFileSync(tool, [clone, "origin/missing"], { stdio: "pipe" }));
});
