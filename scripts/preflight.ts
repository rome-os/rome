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
 * - Biome over the changed files, or the whole repo when `biome.jsonc` changed.
 * - `pnpm lint:imports`, and `pnpm typecheck:lint` when lint/ changed.
 * - Type checks of every workspace package that changed and every package
 *   that depends on one, incremental between runs. A changed package that
 *   others read from `dist` is rebuilt first, so they check against the edit.
 * - The unit tests that import a changed file, in every package whose `test`
 *   script runs rstest. A package whose rstest config or `package.json`
 *   changed runs all its unit tests.
 * - The `node --test` suite of a changed `.mjs` file, and a changed suite.
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
  build?: string;
  /** Other packages read this one's types from its build output. */
  distTypes: boolean;
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
        build: pkg.scripts?.build,
        distTypes: /"\.\/dist\//.test(JSON.stringify([pkg.exports, pkg.types, pkg.main])),
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

/** Splits a script into its `tsc` steps, or returns null when any step is something else. */
function tscSteps(script: string | undefined): string[][] | null {
  if (!script) return null;
  const steps = script.split("&&").map((s) => s.trim().split(/\s+/));
  return steps.every((s) => s[0] === "tsc") ? steps : null;
}

/**
 * Builds of the reached packages that another reached package reads from
 * `dist`, in dependency order: each inner list can run at once.
 */
function buildLevels(reached: Workspace[]): { levels: Check[][]; unbuilt: Workspace[] } {
  const needed = reached.filter(
    (w) => w.distTypes && reached.some((o) => o !== w && o.deps.includes(w.name)),
  );
  const unbuilt = needed.filter((w) => !tscSteps(w.build));
  let left = needed.filter((w) => tscSteps(w.build));
  const levels: Check[][] = [];
  while (left.length > 0) {
    const ready = left.filter((w) => !left.some((o) => o !== w && w.deps.includes(o.name)));
    const level = ready.length > 0 ? ready : left;
    levels.push(
      level.flatMap((w) =>
        (tscSteps(w.build) ?? []).map((s) => ({
          name: `build ${relative(ROOT, w.dir)}`,
          command: join(ROOT, "node_modules/.bin/tsc"),
          args: s.slice(1),
          cwd: w.dir,
        })),
      ),
    );
    left = left.filter((w) => !level.includes(w));
  }
  return { levels, unbuilt };
}

/** `node --test` suites for changed `.mjs` files: a changed suite, or the suite beside a changed module. */
function nodeTestChecks(files: string[]): Check[] {
  const suites = new Set<string>();
  for (const f of files) {
    if (f.endsWith(".test.mjs")) suites.add(f);
    else if (f.endsWith(".mjs") && existsSync(join(ROOT, f.replace(/\.mjs$/, ".test.mjs")))) {
      suites.add(f.replace(/\.mjs$/, ".test.mjs"));
    }
  }
  if (suites.size === 0) return [];
  return [
    {
      name: "node --test",
      command: join(ROOT, "scripts/test-env.sh"),
      args: ["node", "--test", ...suites],
    },
  ];
}

/** The npm Biome the repo pins, or the devShell's when the npm binary cannot run on this host. */
function biomeCommand(): { command: string; note?: string } {
  const pinned = join(ROOT, "node_modules/.bin/biome");
  try {
    execFileSync(pinned, ["--version"], { stdio: "ignore" });
    return { command: pinned };
  } catch {
    return {
      command: "biome",
      note: "- the npm Biome binary does not run here, so Biome comes from PATH and its version may differ from CI's",
    };
  }
}

function testChecks(
  paths: string[],
  code: string[],
  affected: Workspace[],
  all: Workspace[],
): { checks: Check[]; skipped: Workspace[] } {
  // Core's rstest config also collects the tests of rome_apps, scripts, lint and
  // infra, so it runs for every change. Every other package runs its tests when
  // it or a dependency changed. rstest keeps the tests that import a changed file.
  const core = all.filter((w) => w.dir === CORE);
  const candidates = [...new Set([...core, ...affected])].filter((w) => w.test?.includes("rstest"));
  const needsBuild = (w: Workspace) => /\bbuild\b/.test(w.test?.split("rstest")[0] ?? "");
  const abs = code.map((f) => join(ROOT, f));
  // A config file is not in the import graph `--related` follows.
  const configChanged = (w: Workspace) =>
    paths.some((f) => {
      const a = join(ROOT, f);
      return dirname(a) === w.dir && /^(rstest\.config\.[cm]?ts|package\.json)$/.test(basename(a));
    });
  const checks = candidates
    .filter((w) => !needsBuild(w) && (abs.length > 0 || configChanged(w)))
    .map((r) => ({
      name: `unit tests ${relative(ROOT, r.dir)}${configChanged(r) ? " (all)" : ""}`,
      command: join(ROOT, "scripts/test-env.sh"),
      args: [
        join(ROOT, "node_modules/.bin/rstest"),
        "run",
        ...(configChanged(r) ? [] : ["--related", ...abs]),
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
  const tests = testChecks(paths, code, reached, all);
  const builds = buildLevels(reached);
  const biome = biomeCommand();
  const wholeRepoBiome = paths.some((f) => /^biome\.jsonc?$/.test(f));

  // These read only source, so they run while the builds do.
  const independent: Check[] = [
    // Biome with no paths checks the whole repo, so a branch that only deletes skips it.
    ...(files.length > 0
      ? [
          {
            name: wholeRepoBiome ? "biome (whole repo)" : "biome",
            command: biome.command,
            args: [
              "check",
              ...(wholeRepoBiome
                ? []
                : ["--no-errors-on-unmatched", "--files-ignore-unknown=true", ...files]),
            ],
          },
        ]
      : []),
    { name: "lint:imports", command: "pnpm", args: ["-s", "lint:imports"] },
    ...nodeTestChecks(files),
    ...(rootConfig.length > 0 || paths.some((f) => f.startsWith("lint/"))
      ? [{ name: "typecheck:lint", command: "pnpm", args: ["-s", "typecheck:lint"] }]
      : []),
  ];
  // Tests and the larger type checks go first so the pool starts them early.
  const afterBuilds: Check[] = [
    ...tests.checks,
    ...reached
      .toSorted((a, b) => Number(b.dir === CORE) - Number(a.dir === CORE))
      .flatMap(typecheckChecks),
  ];
  const total = independent.length + builds.levels.flat().length + afterBuilds.length;

  if (biome.note) console.log(biome.note);
  for (const w of builds.unbuilt) {
    console.log(`- ${relative(ROOT, w.dir)} is not rebuilt: its build is not plain tsc`);
  }
  for (const w of tests.skipped) {
    console.log(`- unit tests ${relative(ROOT, w.dir)} skipped: they need a build first`);
  }
  if (rootConfig.length > 0) {
    console.log(
      `- ${rootConfig.join(", ")} changed: every package is type-checked, but run pnpm test:unit for the tests`,
    );
  }
  console.log(
    `${paths.length} files changed since ${base.slice(0, 12)}. Running ${total} checks.\n`,
  );
  const size = availableParallelism();
  const built = (async () => {
    const results: Result[] = [];
    for (const level of builds.levels) results.push(...(await pool(level, size)));
    return [...results, ...(await pool(afterBuilds, size))];
  })();
  const results = (await Promise.all([pool(independent, size), built])).flat();
  const failed = results.filter((r) => !r.ok);
  for (const r of failed) {
    console.log(`\n━━ ${r.check.name} ━━\n${r.output.trimEnd()}`);
  }
  const seconds = ((performance.now() - start) / 1000).toFixed(1);
  console.log(
    failed.length === 0
      ? `\nPreflight passed in ${seconds}s.`
      : `\nPreflight failed ${failed.length} of ${total} checks in ${seconds}s.`,
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
