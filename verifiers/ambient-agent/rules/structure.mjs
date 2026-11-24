// Rule 4: no platform-specific logic. (a) The product's diff from its
// merge-base with origin/main touches nothing under connections/kinds/.
// (b) The verifier's own in-process test, run in the product's checkout with
// the product's own test runner: a stand-in connection that only delivers
// mentions, sends replies and answers a history read, and a scripted model.

import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../lib/control.mjs";

const KINDS = "packages/core/src/connections/kinds/";
// Where the test goes in the product's checkout, and the names of its two
// tests, which the runner's output is read for.
export const TEST_SOURCE = fileURLToPath(
  new URL("../product-test/ambient-agent.verifier.test.ts", import.meta.url),
);
export const TEST_PATH = "packages/core/src/ambient-agent.verifier.test.ts";
export const TEST_NAMES = {
  recall: "recall: 10 of 10 facts held after 10 other messages each",
  silence: "silence: 0 sends across 50 unmentioned messages",
  // Reported, not scored: tells a member's mention left unanswered from one
  // answered without the fact.
  guardian: "recall when the guardian asks: not scored",
};

const git = (repo, args) => run(["git", "-C", repo, ...args], [], { timeoutMs: 60_000 });

/** Rule 4(a). */
export async function kindsDiff(repo) {
  const head = await git(repo, ["rev-parse", "HEAD"]);
  const base = await git(repo, ["merge-base", "origin/main", "HEAD"]);
  if (head.code !== 0 || base.code !== 0)
    return {
      result: "not checked",
      reason: `cannot read the merge-base with origin/main in ${repo}: ${(base.stderr || head.stderr).trim()}`,
    };
  const h = head.stdout.trim();
  const b = base.stdout.trim();
  const diff = await git(repo, ["diff", "--name-only", b, h, "--", KINDS]);
  if (diff.code !== 0)
    return { result: "not checked", reason: `git diff failed: ${diff.stderr.trim()}` };
  const files = diff.stdout.split("\n").filter(Boolean);
  const evidence = { head: h, mergeBase: b, files, isMain: h === b };
  if (files.length)
    return { pass: false, reason: `${files.length} file(s) changed under ${KINDS}`, evidence };
  return {
    pass: true,
    reason:
      h === b
        ? `the product commit is origin/main's own history (merge-base = HEAD), so (a) holds trivially`
        : `nothing changed under ${KINDS}`,
    evidence,
  };
}

/**
 * Reads the runner's output for each test. A test counts as run only when a
 * line names it with rstest's mark for passed or failed; the tests' own log
 * lines also name it and carry no mark.
 */
export function readRunner(output) {
  const lines = output.split("\n");
  const outcome = (name) => {
    const marked = lines.filter((l) => l.includes(name) && /^\s*[✓√✗×]/.test(l));
    if (marked.some((l) => /^\s*[✗×]/.test(l))) return "failed";
    if (marked.length) return "passed";
    return null;
  };
  return {
    recall: outcome(TEST_NAMES.recall),
    silence: outcome(TEST_NAMES.silence),
    guardian: outcome(TEST_NAMES.guardian),
  };
}

/**
 * Rule 4(b). With the environment's product-tests control, the test is placed
 * at TEST_PATH in an image of the product's commit and run there. Without
 * it, the test is copied into the scratch checkout, run with the product's
 * runner, and removed.
 */
export async function inProcess(env, { timeoutMs = 1_800_000, prefix = [] } = {}) {
  const repo = env.rome;
  const target = join(repo, TEST_PATH);
  if (existsSync(target))
    return {
      result: "not checked",
      reason: `${TEST_PATH} already exists in the product's checkout`,
    };
  let r;
  let how;
  if (env.productTests) {
    const args = [env.productTests.addFlag, `${TEST_SOURCE}=${TEST_PATH}`];
    how = [...env.productTests.argv, ...args].join(" ");
    r = await run(env.productTests.argv, args, { timeoutMs });
  } else {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(TEST_SOURCE, target);
    try {
      // The product's own runner, as `pnpm --filter @rome/core test` runs it,
      // in the package that holds the test. `prefix` wraps it, such as
      // `nix develop <repo> -c`, for a host whose own Node is not the repo's.
      const argv = [
        ...prefix,
        join(repo, "scripts/test-env.sh"),
        join(repo, "node_modules/.bin/rstest"),
        "run",
        TEST_PATH.replace("packages/core/", ""),
      ];
      how = `${argv.join(" ")} (in packages/core)`;
      r = await run(argv, [], { timeoutMs, cwd: join(repo, "packages/core") });
    } finally {
      rmSync(target, { force: true });
    }
  }
  const output = `${r.stdout}\n${r.stderr}`;
  const outcome = readRunner(output);
  const leftover = existsSync(target);
  const evidence = {
    runner: how,
    exit: r.code,
    seconds: Math.round(r.ms / 1000),
    tests: outcome,
    removed: !leftover,
    outputTail: output.trim().split("\n").slice(-60).join("\n"),
  };
  if (!outcome.recall || !outcome.silence)
    return {
      result: "not checked",
      reason: `the product's test runner did not run both tests (exit ${r.code})`,
      evidence,
    };
  const pass = outcome.recall === "passed" && outcome.silence === "passed";
  const parts = [`recall test ${outcome.recall}`, `silence test ${outcome.silence}`];
  if (outcome.guardian) parts.push(`the guardian asking (not scored) ${outcome.guardian}`);
  return { pass, reason: parts.join(", "), evidence };
}

/** Rule 4: both parts must pass. */
export async function structure(ctx) {
  if (!ctx.env.rome)
    return {
      result: "not checked",
      reason: "env.json names no scratch checkout of the product (repos.rome)",
    };
  const a = await kindsDiff(ctx.env.rome);
  ctx.log(`  (a) ${a.result ?? (a.pass ? "pass" : "fail")}: ${a.reason}`);
  const b = await inProcess(ctx.env, { prefix: ctx.testPrefix ?? [] });
  ctx.log(`  (b) ${b.result ?? (b.pass ? "pass" : "fail")}: ${b.reason}`);
  const evidence = { a, b, testFile: TEST_PATH };
  if (a.pass === false || b.pass === false)
    return {
      result: "fail",
      reason: [a.pass === false && `(a) ${a.reason}`, b.pass === false && `(b) ${b.reason}`]
        .filter(Boolean)
        .join("; "),
      evidence,
    };
  if (a.result === "not checked" || b.result === "not checked")
    return {
      result: "not checked",
      reason: [a.result && `(a) ${a.reason}`, b.result && `(b) ${b.reason}`]
        .filter(Boolean)
        .join("; "),
      evidence,
    };
  return { result: "pass", reason: `(a) ${a.reason}; (b) ${b.reason}`, evidence };
}
