import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AREA_PATHS, AREAS, allAreas, areasForFiles } from "./ci-changed-areas.mjs";

/**
 * Repo root, resolved from the module URL. These tests run on whatever node the
 * runner ships, before `setup-node` pins the version the rest of the repo
 * builds against, so they carry no floor beyond ES modules themselves.
 */
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEST_CONFIGS = [
  "rstest.config.ts",
  "rstest.config.mts",
  "vitest.config.ts",
  "vitest.config.mts",
];

test("a change confined to core's own package leaves the other shards idle", () => {
  assert.deepEqual(areasForFiles(["packages/core/src/db/schema.ts"]), {
    core: true,
    web: false,
    rest: false,
  });
});

test("a kit change runs the web shard and the token gates that walk the kit", () => {
  assert.deepEqual(areasForFiles(["packages/ui/src/styles.css"]), {
    core: false,
    web: true,
    rest: true,
  });
});

test("an app change runs core, which collects app tests, and the gates that walk app bundles", () => {
  assert.deepEqual(areasForFiles(["rome_apps/connector/src/actions/list/index.ts"]), {
    core: true,
    web: false,
    rest: true,
  });
});

test("a shared package fans out to every shard that depends on it", () => {
  assert.deepEqual(areasForFiles(["packages/api-types/src/index.ts"]), allAreas());
});

test("a bundled app template runs core, whose scaffold tests read the real template tree", () => {
  assert.deepEqual(areasForFiles(["packages/app-template/template/README.md"]), {
    core: true,
    web: false,
    rest: true,
  });
});

test("markdown under a claimed tree runs that tree's shards", () => {
  // packages/core/src/profile-memory.test.ts asserts on the contents of the
  // real memory.example/MEMORY.md, so prose there is a test input.
  assert.deepEqual(areasForFiles(["packages/core/memory.example/MEMORY.md"]), {
    core: true,
    web: false,
    rest: false,
  });
});

test("prose in a tree no shard claims runs every shard", () => {
  assert.deepEqual(areasForFiles(["docs/releases.md"]), allAreas());
});

test("a root config no shard claims runs every shard", () => {
  assert.deepEqual(areasForFiles(["pnpm-lock.yaml"]), allAreas());
});

test("an unclassified tree runs every shard rather than skipping on a guess", () => {
  assert.deepEqual(areasForFiles(["some-new-top-level-dir/thing.ts"]), allAreas());
});

test("an empty diff runs every shard, since it means the diff was not narrowed", () => {
  assert.deepEqual(areasForFiles([]), allAreas());
});

test("every declared prefix names a real path, so no rule is dead on a typo", async () => {
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const repoRoot = REPO_ROOT;

  for (const area of AREAS) {
    for (const prefix of AREA_PATHS[area]) {
      assert.ok(
        existsSync(join(repoRoot, prefix)),
        `${area} claims ${prefix}, which is not a path in the repo`,
      );
    }
  }
});

// The mapping above is hand-written, and the invariant it carries — a shard
// skips only when the diff reaches no tree it reads — fails silently when it
// drifts. The two tests below derive what the shards actually read from the
// same sources CI runs, so adding a workspace dependency or a scanned tree
// without teaching the mapping fails here instead of skipping live code.

/** Workspace package name to repo-relative directory. */
async function workspacePackages() {
  const { readdirSync, readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const repoRoot = REPO_ROOT;

  const byName = new Map();
  for (const entry of readdirSync(join(repoRoot, "packages"))) {
    const manifest = join(repoRoot, "packages", entry, "package.json");
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    byName.set(pkg.name, { dir: `packages/${entry}/`, pkg });
  }
  return byName;
}

/** Packages a shard's pnpm script runs, read off the script itself. */
async function shardFilters(shard) {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  const script = root.scripts[`test:unit:${shard}`];
  assert.ok(script, `no test:unit:${shard} script to derive coverage from`);
  return [...script.matchAll(/--filter\s+(\S+)/g)].map((m) => m[1]);
}

test("each shard's prefixes cover the workspace dependency closure of the packages it runs", async () => {
  const workspace = await workspacePackages();

  for (const shard of AREAS) {
    const seen = new Set();
    const queue = await shardFilters(shard);
    let resolved = 0;

    while (queue.length > 0) {
      const name = queue.shift();
      if (seen.has(name)) continue;
      seen.add(name);

      // Only workspace names are queued transitively, so a name that resolves
      // to nothing came from the shard script and points at no package.
      const entry = workspace.get(name);
      assert.ok(entry, `${shard} filters on ${name}, which is not a workspace package`);
      resolved += 1;

      assert.ok(
        AREA_PATHS[shard].some((prefix) => entry.dir.startsWith(prefix)),
        `${shard} runs ${name} (${entry.dir}) but no prefix covers it`,
      );

      const deps = {
        ...entry.pkg.dependencies,
        ...entry.pkg.devDependencies,
        ...entry.pkg.peerDependencies,
      };
      for (const dep of Object.keys(deps)) {
        if (workspace.has(dep)) queue.push(dep);
      }
    }

    assert.ok(resolved > 0, `${shard} resolved no packages, so it asserted nothing`);
  }
});

test("the rest shard's prefixes cover every tree the padding-family gates walk", async () => {
  const { relative } = await import("node:path");
  const { repoRoot, scanRoots } = await import("./check-padding-scale.mjs");
  const { fixed, apps } = scanRoots(repoRoot);

  for (const dir of [...fixed, ...apps]) {
    const rel = `${relative(repoRoot, dir)}/`;
    assert.ok(
      AREA_PATHS.rest.some((prefix) => rel.startsWith(prefix)),
      `the padding-family gates scan ${rel} but no rest prefix covers it`,
    );
  }
});

// The workflow consumes the mapping through three near-identical jobs whose
// only difference is which output key guards their steps. A mistyped key runs
// or skips the wrong suite and still reports green, so the wiring is asserted
// here rather than by reading it. Parsed by line, not with a YAML library, so
// this file keeps running on a bare runner before any install.
async function shardJobBlocks() {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const lines = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8").split("\n");

  const blocks = new Map();
  let current = null;

  for (const line of lines) {
    const header = line.match(/^ {2}([\w-]+):\s*$/);
    if (header) {
      const shard = header[1].match(/^unit-tests-(\w+)$/);
      current = shard ? shard[1] : null;
      if (current) blocks.set(current, []);
      continue;
    }
    if (current) blocks.get(current).push(line);
  }

  return blocks;
}

test("each shard job guards its steps on its own detection output", async () => {
  const blocks = await shardJobBlocks();

  assert.deepEqual([...blocks.keys()].sort(), [...AREAS].sort());

  for (const [shard, body] of blocks) {
    const guards = body.flatMap((line) => [...line.matchAll(/steps\.areas\.outputs\.(\w+)/g)]);
    const runGuards = body.filter((line) => /steps\.areas\.outputs\.\w+ == 'true'/.test(line));

    for (const [, key] of guards) {
      assert.equal(key, shard, `the ${shard} job guards a step on steps.areas.outputs.${key}`);
    }

    // pnpm/action-setup, setup-node, install, and the suite itself. A guard
    // dropped from any of them runs that step on a shard meant to stay idle.
    assert.equal(
      runGuards.length,
      4,
      `the ${shard} job has ${runGuards.length} guarded steps, want 4`,
    );

    assert.ok(
      body.some((line) => line.includes(`steps.areas.outputs.${shard} == ''`)),
      `the ${shard} job does not fail when detection emits no verdict`,
    );

    assert.ok(
      body.some((line) => line.includes("node --test scripts/ci-changed-areas.test.mjs")),
      `the ${shard} job never validates the mapping it reads`,
    );
  }
});

/**
 * Trees a shard collects tests from that lie outside the packages it filters
 * on, read off the test runner configs. The core suite's `include` reaches
 * rome_apps, scripts, and infra, so its dependency closure does not describe
 * everything it reads. A shard whose tests all live in its own packages
 * contributes nothing here.
 */
async function extraIncludeRoots(shard) {
  const { readFileSync, existsSync } = await import("node:fs");
  const { join, normalize } = await import("node:path");
  const repoRoot = REPO_ROOT;
  const workspace = await workspacePackages();

  const roots = new Set();
  for (const name of await shardFilters(shard)) {
    const entry = workspace.get(name);
    if (!entry) continue;

    for (const config of TEST_CONFIGS) {
      const path = join(repoRoot, entry.dir, config);
      if (!existsSync(path)) continue;

      const block = readFileSync(path, "utf8").match(/include:\s*\[([^\]]*)\]/);
      if (!block) continue;

      for (const [, glob] of block[1].matchAll(/"([^"]+)"/g)) {
        const root = normalize(join(entry.dir, glob.split("*")[0]));
        if (!root.startsWith(entry.dir)) roots.add(root);
      }
    }
  }
  return [...roots];
}

async function collectedTests(root) {
  const { readdirSync } = await import("node:fs");
  const { join } = await import("node:path");

  const found = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", "dist", "build", "coverage"].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/\.test\.tsx?$/.test(entry.name)) found.push(path);
    }
  };
  visit(root);
  return found;
}

test("no test collected from a shard's extra include roots imports a package it does not declare", async () => {
  const { readFileSync, existsSync, statSync } = await import("node:fs");
  const { dirname, join, resolve } = await import("node:path");
  const repoRoot = REPO_ROOT;
  const workspace = await workspacePackages();

  const specifiers = (file) =>
    [...readFileSync(file, "utf8").matchAll(/(?:from\s+|import\()\s*"([^"]+)"/g)].map((m) => m[1]);

  // Relative specifiers carry a `.js` extension for ESM even in TypeScript.
  const resolveLocal = (spec, from) => {
    if (!spec.startsWith(".")) return null;
    const base = resolve(dirname(from), spec.replace(/\.js$/, ""));
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    return null;
  };

  let walked = 0;

  for (const shard of AREAS) {
    for (const root of await extraIncludeRoots(shard)) {
      for (const entry of await collectedTests(join(repoRoot, root))) {
        walked += 1;
        const seen = new Set([entry]);
        const queue = [entry];

        while (queue.length > 0) {
          const file = queue.shift();
          for (const spec of specifiers(file)) {
            const owner = [...workspace.entries()].find(
              ([name]) => spec === name || spec.startsWith(`${name}/`),
            );
            if (owner) {
              assert.ok(
                AREA_PATHS[shard].some((prefix) => owner[1].dir.startsWith(prefix)),
                `${entry.replace(`${repoRoot}/`, "")} reaches ${owner[0]} (${owner[1].dir}), which no ${shard} prefix covers`,
              );
            }
            const next = resolveLocal(spec, file);
            if (next && !seen.has(next)) {
              seen.add(next);
              queue.push(next);
            }
          }
        }
      }
    }
  }

  assert.ok(walked > 0, "no tests were walked, so this asserted nothing");
});

test("each shard covers the launcher scripts its packages invoke", async () => {
  const workspace = await workspacePackages();

  for (const shard of AREAS) {
    for (const name of await shardFilters(shard)) {
      const entry = workspace.get(name);
      assert.ok(entry, `${shard} filters on ${name}, which is not a workspace package`);

      const script = entry.pkg.scripts?.test ?? entry.pkg.scripts?.["test:unit"] ?? "";
      // Package scripts reach the repo root relatively: `../../scripts/foo.sh`.
      for (const [, path] of script.matchAll(/(?:\.\.\/)*(scripts\/[\w./-]+)/g)) {
        assert.ok(
          AREA_PATHS[shard].some((prefix) => path.startsWith(prefix)),
          `${shard} runs ${name} through ${path}, which no prefix covers`,
        );
      }
    }
  }
});

test("each shard covers the collection roots its test runner configs declare", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const { join, normalize } = await import("node:path");
  const repoRoot = REPO_ROOT;
  const workspace = await workspacePackages();

  let checked = 0;

  for (const shard of AREAS) {
    for (const name of await shardFilters(shard)) {
      const entry = workspace.get(name);
      if (!entry) continue;

      for (const config of TEST_CONFIGS) {
        const path = join(repoRoot, entry.dir, config);
        if (!existsSync(path)) continue;

        const block = readFileSync(path, "utf8").match(/include:\s*\[([^\]]*)\]/);
        if (!block) continue;

        for (const [, glob] of block[1].matchAll(/"([^"]+)"/g)) {
          // A glob's fixed prefix is the tree it collects from: everything
          // before the first wildcard, resolved against the package it is
          // declared in.
          const root = `${normalize(join(entry.dir, glob.split("*")[0]))}`;
          assert.ok(
            AREA_PATHS[shard].some((prefix) => root.startsWith(prefix)),
            `${shard} collects tests from ${root} (${entry.dir}${config}) but no prefix covers it`,
          );
          checked += 1;
        }
      }
    }
  }

  assert.ok(checked > 0, "no test include globs were resolved, so this asserted nothing");
});

/** Every root script a shard's chain reaches, following `pnpm <script>` hops. */
async function shardScriptChain(shard) {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const scripts = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).scripts;

  const seen = new Set();
  const queue = [`test:unit:${shard}`];
  const bodies = [];

  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name) || !scripts[name]) continue;
    seen.add(name);
    bodies.push(scripts[name]);

    for (const [, next] of scripts[name].matchAll(/pnpm\s+(test:[\w:]+)/g)) queue.push(next);
  }

  return bodies;
}

test("each shard covers every repo path its script chain names", async () => {
  let checked = 0;

  for (const shard of AREAS) {
    for (const body of await shardScriptChain(shard)) {
      // Path arguments the chain hands to a runner — test globs, gate scripts,
      // the launcher. A glob's fixed prefix is the tree it reaches.
      for (const [, path] of body.matchAll(
        /(?:^|\s)(?:\.\.\/)*((?:scripts|infra|packages|rome_apps)\/[\w./*-]+)/g,
      )) {
        const root = path.split("*")[0];
        assert.ok(
          AREA_PATHS[shard].some((prefix) => root.startsWith(prefix) || prefix.startsWith(root)),
          `${shard} runs ${path}, which no prefix covers`,
        );
        checked += 1;
      }
    }
  }

  assert.ok(checked > 0, "no script paths were resolved, so this asserted nothing");
});

/**
 * Stylesheet the token gates compile, via `loadDesignSystem()` in
 * `scripts/check-utility-tokens.mjs`. Its import list is what drifts as
 * components are added, so the packages it pulls in are derived rather than
 * listed here.
 */
const DESIGN_SYSTEM_ENTRY = "packages/web/src/globals.css";

test("the rest shard covers every workspace package the compiled stylesheet imports", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const workspace = await workspacePackages();

  const css = readFileSync(join(REPO_ROOT, DESIGN_SYSTEM_ENTRY), "utf8");
  const specifiers = [...css.matchAll(/@import\s+"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(specifiers.length > 0, `${DESIGN_SYSTEM_ENTRY} declared no imports`);

  let checked = 0;
  for (const spec of specifiers) {
    const owner = [...workspace.entries()].find(
      ([name]) => spec === name || spec.startsWith(`${name}/`),
    );
    if (!owner) continue;

    assert.ok(
      AREA_PATHS.rest.some((prefix) => owner[1].dir.startsWith(prefix)),
      `the token gates compile ${DESIGN_SYSTEM_ENTRY}, which imports ${owner[0]} (${owner[1].dir}), but no rest prefix covers it`,
    );
    checked += 1;
  }

  assert.ok(checked > 0, "no workspace imports were resolved, so this asserted nothing");
});
