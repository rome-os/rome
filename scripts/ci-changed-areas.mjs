// Decides which unit-test shards a change has to run. CI shape: .github/workflows/ci.yml.
//
// A shard skipped by mistake reports green without having run, so every rule
// here resolves ambiguity toward running. The areas below list the trees each
// shard *reads*, which is wider than the package it is named for: the core
// suite collects tests out of `rome_apps`, `scripts`, and `infra` and reads the
// bundled app templates, and the token gates in the rest shard walk the kit,
// the dashboard, the web SDK, the app scaffolds, and every app's web bundle.
//
// No path is exempt. A tree no shard claims runs every shard, so prose under a
// directory of its own costs runner minutes rather than a rule that has to stay
// correct as tests start reading files it excused.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Trees each shard reads, longest-prefix-agnostic: a changed path under any
 * listed prefix marks that shard. A path under no prefix marks every shard.
 */
export const AREA_PATHS = {
  core: [
    "packages/core/",
    "packages/rome-node/",
    "packages/app-runtime-sdk/",
    "packages/api-types/",
    "packages/lib/",
    "packages/app-template/",
    "rome_apps/",
    "scripts/",
    "infra/",
  ],
  web: [
    "packages/web/",
    "packages/ui/",
    "packages/web-content/",
    "packages/api-types/",
    "packages/app-runtime-sdk/",
    // Every package launches its suite through this wrapper, so a change to it
    // changes how the web suites run even though nothing else in scripts/ does.
    "scripts/test-env.sh",
  ],
  rest: [
    "packages/lib/",
    "packages/discord-cli/",
    "packages/rome-node/",
    "packages/app-runtime-sdk/",
    "packages/desktop/",
    "packages/desktop-base-web/",
    "packages/api-types/",
    "packages/ui/",
    "packages/web/",
    "packages/app-web-sdk/",
    "packages/app-template/",
    // The token gates compile packages/web/src/globals.css, which pulls this
    // package's stylesheets into the design system they check.
    "packages/web-content/",
    "rome_apps/",
    "scripts/",
    "infra/",
  ],
};

export const AREAS = Object.keys(AREA_PATHS);

/** Every shard, for the callers that cannot determine what changed. */
export function allAreas() {
  return Object.fromEntries(AREAS.map((area) => [area, true]));
}

/**
 * Maps changed repo-relative paths to the shards that must run. An empty list
 * means the diff could not be narrowed rather than that nothing changed, so it
 * yields every shard.
 */
export function areasForFiles(files) {
  if (files.length === 0) return allAreas();

  const areas = Object.fromEntries(AREAS.map((area) => [area, false]));

  for (const file of files) {
    // A path claimed by no shard is one this mapping has not been taught —
    // a new top-level directory, or a root config every package loads. Run
    // everything until someone classifies it.
    const claimed = AREAS.filter((area) =>
      AREA_PATHS[area].some((prefix) => file.startsWith(prefix)),
    );
    if (claimed.length === 0) return allAreas();

    for (const area of claimed) areas[area] = true;
  }

  return areas;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

/**
 * Changed paths for the current GitHub event, or null when the diff base is
 * unavailable — a force push, a branch's first push, or a shallow checkout.
 */
export function changedFiles(env = process.env) {
  let base;

  if (env.GITHUB_BASE_REF) {
    // `checkout` builds the merge commit for a pull_request event, so the
    // merge base against the target branch is the PR's own starting point.
    base = git(["merge-base", `origin/${env.GITHUB_BASE_REF}`, "HEAD"]).trim();
  } else if (env.GITHUB_EVENT_BEFORE && !/^0+$/.test(env.GITHUB_EVENT_BEFORE)) {
    base = env.GITHUB_EVENT_BEFORE;
    // A push whose predecessor was garbage-collected or never fetched leaves a
    // sha that does not resolve; there is nothing to diff against.
    git(["cat-file", "-e", `${base}^{commit}`]);
  } else {
    return null;
  }

  return git(["diff", "--name-only", base, "HEAD"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function main() {
  let files;
  try {
    files = changedFiles();
  } catch (error) {
    console.error(`ci-changed-areas: diff failed, running every shard — ${error.message}`);
    files = null;
  }

  const areas = files === null ? allAreas() : areasForFiles(files);

  if (files !== null) {
    console.error(`ci-changed-areas: ${files.length} changed path(s)`);
  }
  for (const [area, run] of Object.entries(areas)) {
    console.error(`ci-changed-areas: ${area}=${run}`);
    console.log(`${area}=${run}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
