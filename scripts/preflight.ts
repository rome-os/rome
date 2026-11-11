#!/usr/bin/env tsx
/**
 * Runs the fast checks for the files a branch changed, in parallel, so a
 * change can be verified in well under a minute before CI sees it.
 *
 *   pnpm preflight [--base <ref>]
 *
 * The changed files are everything that differs from `<ref>` in the working
 * tree, untracked files included. `<ref>` defaults to the merge base with
 * origin/main. The checks are:
 *
 * - Biome over the changed files.
 * - `pnpm lint:imports`, and `pnpm typecheck:lint` when lint/ changed.
 * - Type checks of every workspace package that changed and every package
 *   that depends on one, incremental between runs.
 * - The unit tests that import a changed file, in every package whose `test`
 *   script runs rstest.
 *
 * A deleted or renamed file counts toward the package that held it. A change
 * to root config such as `tsconfig.json` or `pnpm-lock.yaml` type-checks every
 * package, and prints a reminder that only `pnpm test:unit` covers its effect
 * on tests. Tests that need a Linux host with flock or a session bus are left
 * out, as are integration and e2e tests and packages whose tests need a build
 * first. CI runs all of them.
 *
 * At most `os.availableParallelism()` checks run at once.
 */

import { type SpawnOptions, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, "node_modules/.cache/preflight");
const CORE = join(ROOT, "packages/core");
const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
/** Files outside every workspace that every workspace reads. */
const ROOT_CONFIG = /^(tsconfig.*\.json|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/;

/** Unit tests that fail on hosts without flock or a D-Bus session bus. */
const HOST_BOUND_TESTS = [
  "../../scripts/docker/**",
  "src/connections/kinds/wechat-user/wechat-user-session.test.ts",
];

interface Check {
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

interface Workspace {
  name: string;
  dir: string;
  deps: string[];
  typecheck?: string;
  test?: string;
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function baseRef(argv: string[]): string {
  const i = argv.indexOf("--base");
  if (i >= 0) {
    const ref = argv[i + 1];
    if (!ref) throw new Error("--base needs a ref");
    return ref;
  }
  for (const main of ["origin/main", "main"]) {
    try {
      return git("merge-base", "HEAD", main);
    } catch {}
  }
  return "HEAD";
}

/** Every changed path, with a deleted file and both sides of a rename kept. */
function changedPaths(base: string): string[] {
  const tracked = git("diff", "--name-only", "--no-renames", base);
  const untracked = git("ls-files", "--others", "--exclude-standard");
  return [...new Set(`${tracked}\n${untracked}`.split("\n").filter(Boolean))].sort();
}

function workspaces(): Workspace[] {
  const listed = JSON.parse(
    execFileSync("pnpm", ["ls", "-r", "--depth", "-1", "--json"], { cwd: ROOT, encoding: "utf8" }),
  ) as { name: string; path: string }[];
  return listed
    .filter((p) => p.path !== ROOT)
    .map((p) => {
      const pkg = JSON.parse(readFileSync(join(p.path, "package.json"), "utf8"));
      return {
        name: p.name,
        dir: p.path,
        deps: Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }),
        typecheck: pkg.scripts?.typecheck,
        test: pkg.scripts?.test,
      };
    });
}

function owner(file: string, all: Workspace[]): Workspace | undefined {
  const abs = join(ROOT, file);
  return all
    .filter((w) => abs.startsWith(`${w.dir}/`))
    .sort((a, b) => b.dir.length - a.dir.length)[0];
}

/** The changed workspaces plus everything that depends on them, transitively. */
function affected(changed: Set<Workspace>, all: Workspace[]): Workspace[] {
  const out = new Set(changed);
  let grew = true;
  while (grew) {
    grew = false;
    for (const w of all) {
      if (out.has(w)) continue;
      if ([...out].some((o) => w.deps.includes(o.name))) {
        out.add(w);
        grew = true;
      }
    }
  }
  return [...out];
}

/**
 * Turns a `tsc --noEmit [-p <project>]` chain into incremental runs, each with
 * its own build info under the cache. Any other script runs as written.
 */
function typecheckChecks(w: Workspace): Check[] {
  if (!w.typecheck) return [];
  const label = relative(ROOT, w.dir);
  const steps = w.typecheck.split("&&").map((s) => s.trim().split(/\s+/));
  if (!steps.every((s) => s[0] === "tsc" && s.includes("--noEmit"))) {
    return [
      { name: `typecheck ${label}`, command: "pnpm", args: ["run", "typecheck"], cwd: w.dir },
    ];
  }
  return steps.map((s) => {
    const p = s.indexOf("-p");
    const project = p >= 0 ? s[p + 1] : "tsconfig.json";
    const buildInfo = join(CACHE, `${label}/${project}`.replaceAll("/", "__") + ".tsbuildinfo");
    return {
      name: `typecheck ${label}${p >= 0 ? ` (${project})` : ""}`,
      command: join(ROOT, "node_modules/.bin/tsc"),
      args: [...s.slice(1), "--incremental", "--tsBuildInfoFile", buildInfo],
      cwd: w.dir,
    };
  });
}

function testChecks(
  code: string[],
  affected: Workspace[],
  all: Workspace[],
): { checks: Check[]; skipped: Workspace[] } {
  if (code.length === 0) return { checks: [], skipped: [] };
  // Core's rstest config also collects the tests of rome_apps, scripts, lint and
  // infra, so it runs for every change. Every other package runs its tests when
  // it or a dependency changed. rstest keeps the tests that import a changed file.
  const core = all.filter((w) => w.dir === CORE);
  const candidates = [...new Set([...core, ...affected])].filter((w) => w.test?.includes("rstest"));
  const needsBuild = (w: Workspace) => /\bbuild\b/.test(w.test?.split("rstest")[0] ?? "");
  const abs = code.map((f) => join(ROOT, f));
  const checks = candidates
    .filter((w) => !needsBuild(w))
    .map((r) => ({
      name: `unit tests ${relative(ROOT, r.dir)}`,
      command: join(ROOT, "scripts/test-env.sh"),
      args: [
        join(ROOT, "node_modules/.bin/rstest"),
        "run",
        "--related",
        ...abs,
        "--passWithNoTests",
        "--silent",
        "passed-only",
        "--exclude",
        "**/*.integration.test.ts",
        "--exclude",
        "**/*.e2e.test.ts",
        ...(r.dir === CORE ? HOST_BOUND_TESTS.flatMap((t) => ["--exclude", t]) : []),
      ],
      cwd: r.dir,
    }));
  return { checks, skipped: candidates.filter(needsBuild) };
}

interface Result {
  check: Check;
  ok: boolean;
  seconds: number;
  output: string;
}

function run(check: Check): Promise<Result> {
  const start = performance.now();
  const options: SpawnOptions = {
    cwd: check.cwd ?? ROOT,
    env: { ...process.env, FORCE_COLOR: "1", ...check.env },
  };
  return new Promise((done) => {
    const child = spawn(check.command, check.args, options);
    let output = "";
    child.stdout?.on("data", (d) => (output += d));
    child.stderr?.on("data", (d) => (output += d));
    const finish = (ok: boolean) => {
      const seconds = (performance.now() - start) / 1000;
      const result = { check, ok, seconds, output };
      console.log(`${ok ? "✓" : "✗"} ${check.name} ${seconds.toFixed(1)}s`);
      done(result);
    };
    child.on("error", (e) => {
      output += String(e);
      finish(false);
    });
    child.on("close", (code) => finish(code === 0));
  });
}

/** Runs the checks in list order, at most `size` at a time. */
async function pool(checks: Check[], size: number): Promise<Result[]> {
  const results: Result[] = [];
  let next = 0;
  const lane = async () => {
    while (next < checks.length) {
      const i = next++;
      results[i] = await run(checks[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, checks.length) }, lane));
  return results;
}

async function main() {
  const start = performance.now();
  const base = baseRef(process.argv.slice(2));
  const paths = changedPaths(base);
  if (paths.length === 0) {
    console.log(`No files changed since ${base.slice(0, 12)}.`);
    return;
  }
  mkdirSync(CACHE, { recursive: true });
  const all = workspaces();
  const files = paths.filter((f) => existsSync(join(ROOT, f)));
  const code = files.filter((f) => CODE.test(f));
  const rootConfig = paths.filter(
    (f) => !owner(f, all) && ROOT_CONFIG.test(basename(f)) && !f.includes("/"),
  );
  const touched = new Set(paths.map((f) => owner(f, all)).filter((w) => w !== undefined));
  const reached = rootConfig.length > 0 ? all : affected(touched, all);
  const tests = testChecks(code, reached, all);

  const checks: Check[] = [
    // Biome with no paths checks the whole repo, so a branch that only deletes skips it.
    ...(files.length > 0
      ? [
          {
            name: "biome",
            command: join(ROOT, "node_modules/.bin/biome"),
            args: ["check", "--no-errors-on-unmatched", "--files-ignore-unknown=true", ...files],
          },
        ]
      : []),
    { name: "lint:imports", command: "pnpm", args: ["-s", "lint:imports"] },
    // Tests and the larger type checks go first so the pool starts them early.
    ...tests.checks,
    ...(rootConfig.length > 0 || paths.some((f) => f.startsWith("lint/"))
      ? [{ name: "typecheck:lint", command: "pnpm", args: ["-s", "typecheck:lint"] }]
      : []),
    ...reached
      .toSorted((a, b) => Number(b.dir === CORE) - Number(a.dir === CORE))
      .flatMap(typecheckChecks),
  ];

  for (const w of tests.skipped) {
    console.log(`- unit tests ${relative(ROOT, w.dir)} skipped: they need a build first`);
  }
  if (rootConfig.length > 0) {
    console.log(
      `- ${rootConfig.join(", ")} changed: every package is type-checked, but run pnpm test:unit for the tests`,
    );
  }
  console.log(
    `${paths.length} files changed since ${base.slice(0, 12)}. Running ${checks.length} checks.\n`,
  );
  const results = await pool(checks, availableParallelism());
  const failed = results.filter((r) => !r.ok);
  for (const r of failed) {
    console.log(`\n━━ ${r.check.name} ━━\n${r.output.trimEnd()}`);
  }
  const seconds = ((performance.now() - start) / 1000).toFixed(1);
  console.log(
    failed.length === 0
      ? `\nPreflight passed in ${seconds}s.`
      : `\nPreflight failed ${failed.length} of ${checks.length} checks in ${seconds}s.`,
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
