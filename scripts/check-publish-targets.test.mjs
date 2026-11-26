import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The set of publishable packages is spelled out in three places that no tool
// reconciles: release-please-config.json decides what gets a version, the `all`
// branch in sdk-publish.yml decides what a bare manual dispatch publishes, and
// release.yml's choice input decides what a human can pick. Drift between them
// is silent and only surfaces mid-release — a package in `all` without an npm
// Trusted Publisher fails every `all` dispatch, and one missing from `all` is
// reachable only by name.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

const configuredPackages = Object.keys(JSON.parse(read("release-please-config.json")).packages);

/** The JSON array literal the `all` branch of sdk-publish.yml echoes. */
function manualAllTargets() {
  const source = read(".github/workflows/sdk-publish.yml");
  const match = source.match(/echo 'paths=(\[[^\]]*\])' >> "\$GITHUB_OUTPUT"/);
  assert.ok(match, "sdk-publish.yml no longer echoes a literal `all` path list");
  return JSON.parse(match[1]);
}

/** The `- packages/...` entries under the dispatch input's `options:` key. */
function dispatchOptions() {
  const source = read(".github/workflows/release.yml");
  const options = source.match(/^ {8}options:\n((?: {10}- \S+\n)+)/m);
  assert.ok(options, "release.yml no longer lists dispatch options");
  return options[1]
    .split("\n")
    .filter(Boolean)
    .map((line) => line.replace(/^ {10}- /, ""));
}

test("a bare `all` dispatch publishes every released package", () => {
  assert.deepEqual(manualAllTargets().slice().sort(), configuredPackages.slice().sort());
});

test("every released package is selectable on its own", () => {
  assert.deepEqual(dispatchOptions(), ["all", ...configuredPackages]);
});

test("every released package declares this repository", () => {
  for (const path of configuredPackages) {
    const manifest = JSON.parse(read(`${path}/package.json`));
    assert.deepEqual(
      manifest.repository,
      {
        type: "git",
        url: "git+https://github.com/rome-os/rome.git",
        directory: path,
      },
      `${path}/package.json must declare repository, or npm rejects the upload with HTTP 422`,
    );
  }
});

test("Rome Node Core and its optional platform package release at the same version", () => {
  const platformPath = "packages/rome-node-core-darwin-arm64";
  const corePath = "packages/rome-node-core";
  const core = JSON.parse(read(`${corePath}/package.json`));
  const platform = JSON.parse(read(`${platformPath}/package.json`));
  const releases = JSON.parse(read(".release-please-manifest.json"));
  assert.equal(core.version, platform.version);
  assert.equal(releases[corePath], releases[platformPath]);
  assert.equal(core.optionalDependencies[platform.name], "workspace:*");
  assert.deepEqual(platform.os, ["darwin"]);
  assert.deepEqual(platform.cpu, ["arm64"]);
});
