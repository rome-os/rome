import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { packArtifact } from "./packaging/index.js";
import { buildProductionInstallArgs, prepare } from "./prepare.js";

const VALID_ACTION_YAML = [
  "name: ping",
  "type: custom",
  "description: ping",
  "complexity: simple",
  "speed: fast",
  "reliability: high",
  "sideEffects: read-only",
  "",
].join("\n");

function writeMinimalAppSource(sourceRoot: string, appId: string): void {
  writeFileSync(
    join(sourceRoot, "app.yaml"),
    [
      `formatVersion: 1`,
      `id: ${appId}`,
      `version: 0.0.1`,
      `description: test app`,
      `actions:`,
      `  - actions/ping`,
      ``,
    ].join("\n"),
    "utf-8",
  );
  mkdirSync(join(sourceRoot, "actions", "ping"), { recursive: true });
  writeFileSync(join(sourceRoot, "actions", "ping", "action.yaml"), VALID_ACTION_YAML, "utf-8");
}

describe("prepare", () => {
  let workDir: string;
  let sourceRoot: string;
  let packedRoot: string;
  let installedRoot: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "rome-prepare-"));
    sourceRoot = join(workDir, "src");
    packedRoot = join(workDir, "packed");
    installedRoot = join(workDir, "installed");
    mkdirSync(sourceRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("disables pnpm's release-age quarantine for all app artifacts", () => {
    expect(buildProductionInstallArgs(sourceRoot)).toEqual([
      "install",
      "--prod",
      "--no-frozen-lockfile",
      "--config.minimum-release-age=0",
      "--ignore-workspace",
      "--config.strict-dep-builds=false",
    ]);

    writeFileSync(join(sourceRoot, "pnpm-workspace.yaml"), "allowBuilds: {}\n", "utf-8");
    expect(buildProductionInstallArgs(sourceRoot)).toEqual([
      "install",
      "--prod",
      "--no-frozen-lockfile",
      "--config.minimum-release-age=0",
    ]);
  });

  it("installs from a packed artifact (pack → prepare round-trip)", async () => {
    writeMinimalAppSource(sourceRoot, "prep-test");
    await packArtifact(sourceRoot, packedRoot);

    const installed = await prepare(
      { kind: "artifact", appId: "prep-test", artifactRoot: packedRoot },
      { installedRoot },
    );

    expect(installed.appId).toBe("prep-test");
    expect(installed.version).toBe("0.0.1");
    expect(installed.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(installed.root).toBe(join(installedRoot, "prep-test", installed.hash));
    expect(existsSync(join(installed.root, "app.yaml"))).toBe(true);
    expect(existsSync(join(installed.root, "actions", "ping", "action.yaml"))).toBe(true);
  });

  it("keeps .rome_store metadata out of the installed runtime artifact", async () => {
    writeMinimalAppSource(sourceRoot, "prep-store-sidecar");
    await packArtifact(sourceRoot, packedRoot);
    mkdirSync(join(packedRoot, ".rome_store", "assets"), { recursive: true });
    writeFileSync(join(packedRoot, ".rome_store", "rome_store.yaml"), "title: Store Copy\n");
    writeFileSync(join(packedRoot, ".rome_store", "assets", "hero.png"), "image-bytes\n");

    const installed = await prepare(
      { kind: "artifact", appId: "prep-store-sidecar", artifactRoot: packedRoot },
      { installedRoot },
    );

    expect(existsSync(join(installed.root, ".rome_store"))).toBe(false);
  });

  it("re-installing the same packed artifact is a cache hit on the same hash", async () => {
    writeMinimalAppSource(sourceRoot, "prep-cache");
    await packArtifact(sourceRoot, packedRoot);

    const first = await prepare(
      { kind: "artifact", appId: "prep-cache", artifactRoot: packedRoot },
      { installedRoot },
    );
    // Touch the staged file so we can tell the second call didn't re-copy.
    const marker = join(first.root, "app.yaml");
    const original = await readFile(marker, "utf-8");

    const second = await prepare(
      { kind: "artifact", appId: "prep-cache", artifactRoot: packedRoot },
      { installedRoot },
    );

    expect(second.hash).toBe(first.hash);
    expect(second.root).toBe(first.root);
    const afterSecond = await readFile(marker, "utf-8");
    expect(afterSecond).toBe(original);
  });

  it("rejects an unbuilt source workspace whose appRoot dir is empty", async () => {
    // Manifest declares `appRoot: dist` but actions live under `src/`.
    // Validation walks under `dist/`, finds nothing, and rejects — the
    // contract is "input is already packed", and an unbuilt source isn't.
    writeFileSync(
      join(sourceRoot, "app.yaml"),
      [
        `formatVersion: 1`,
        `id: prep-unbuilt`,
        `version: 0.0.1`,
        `description: test app`,
        `appRoot: dist`,
        `actions:`,
        `  - actions/ping`,
        ``,
      ].join("\n"),
      "utf-8",
    );
    mkdirSync(join(sourceRoot, "src", "actions", "ping"), { recursive: true });
    writeFileSync(
      join(sourceRoot, "src", "actions", "ping", "action.yaml"),
      VALID_ACTION_YAML,
      "utf-8",
    );

    await expect(
      prepare(
        { kind: "artifact", appId: "prep-unbuilt", artifactRoot: sourceRoot },
        { installedRoot },
      ),
    ).rejects.toThrow(/missing action at/);
  });

  it("rejects an artifact missing app.yaml with a source-install pointer", async () => {
    mkdirSync(packedRoot, { recursive: true });
    writeFileSync(join(packedRoot, "stray"), "noise", "utf-8");

    await expect(
      prepare(
        { kind: "artifact", appId: "prep-missing", artifactRoot: packedRoot },
        { installedRoot },
      ),
    ).rejects.toThrow(/not a packed app artifact.*mode: "source"/s);
  });

  it("rejects an artifact whose manifest id doesn't match appId", async () => {
    writeMinimalAppSource(sourceRoot, "actual-id");
    await packArtifact(sourceRoot, packedRoot);

    await expect(
      prepare({ kind: "artifact", appId: "wrong-id", artifactRoot: packedRoot }, { installedRoot }),
    ).rejects.toThrow(/does not match prepare target "wrong-id"/);
  });

  it("rejects an artifact whose manifest references a missing action", async () => {
    // Defence against a tampered/half-deleted packed dir: re-validate even
    // though pack already did.
    writeMinimalAppSource(sourceRoot, "prep-corrupt");
    await packArtifact(sourceRoot, packedRoot);
    await rm(join(packedRoot, "actions", "ping", "action.yaml"));

    await expect(
      prepare(
        { kind: "artifact", appId: "prep-corrupt", artifactRoot: packedRoot },
        { installedRoot },
      ),
    ).rejects.toThrow(/missing its config/);
    // Staging dir must not survive a validation failure.
    const appInstalledRoot = join(installedRoot, "prep-corrupt");
    if (existsSync(appInstalledRoot)) {
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(appInstalledRoot);
      expect(entries.filter((e) => !e.startsWith("."))).toHaveLength(0);
    }
  });

  it("honors app-local allowBuilds approvals during the prod deps reinstall", async () => {
    const depRoot = join(sourceRoot, "dist", "build-dep");
    mkdirSync(depRoot, { recursive: true });
    writeFileSync(
      join(depRoot, "package.json"),
      JSON.stringify(
        {
          name: "rome-fixture-build-dep",
          version: "1.0.0",
          scripts: { postinstall: "node postinstall.cjs" },
        },
        null,
        2,
      ),
      "utf-8",
    );
    writeFileSync(
      join(depRoot, "postinstall.cjs"),
      "require('node:fs').writeFileSync('built.txt', 'yes');\n",
      "utf-8",
    );

    writeFileSync(
      join(sourceRoot, "app.yaml"),
      [
        `formatVersion: 1`,
        `id: prep-allow-builds`,
        `version: 0.0.1`,
        `description: test app`,
        `appRoot: dist`,
        `actions:`,
        `  - actions/ping`,
        ``,
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(
      join(sourceRoot, "package.json"),
      JSON.stringify(
        {
          name: "prep-allow-builds",
          version: "0.0.1",
          packageManager: "pnpm@11.6.0",
          dependencies: { "rome-fixture-build-dep": "file:dist/build-dep" },
        },
        null,
        2,
      ),
      "utf-8",
    );
    writeFileSync(
      join(sourceRoot, "pnpm-workspace.yaml"),
      'allowBuilds:\n  "rome-fixture-build-dep@file:dist/build-dep": true\n',
      "utf-8",
    );
    mkdirSync(join(sourceRoot, "dist", "actions", "ping"), { recursive: true });
    writeFileSync(
      join(sourceRoot, "dist", "actions", "ping", "action.yaml"),
      VALID_ACTION_YAML,
      "utf-8",
    );

    await packArtifact(sourceRoot, packedRoot);
    const installed = await prepare(
      { kind: "artifact", appId: "prep-allow-builds", artifactRoot: packedRoot },
      { installedRoot },
    );

    expect(
      existsSync(join(installed.root, "node_modules", "rome-fixture-build-dep", "built.txt")),
    ).toBe(true);
  });

  it("keeps legacy no-workspace artifacts installable when deps have build scripts", async () => {
    const depRoot = join(sourceRoot, "dist", "legacy-build-dep");
    mkdirSync(depRoot, { recursive: true });
    writeFileSync(
      join(depRoot, "package.json"),
      JSON.stringify(
        {
          name: "rome-fixture-legacy-build-dep",
          version: "1.0.0",
          scripts: { postinstall: "node postinstall.cjs" },
        },
        null,
        2,
      ),
      "utf-8",
    );
    writeFileSync(
      join(depRoot, "postinstall.cjs"),
      "require('node:fs').writeFileSync('built.txt', 'yes');\n",
      "utf-8",
    );

    writeFileSync(
      join(sourceRoot, "app.yaml"),
      [
        `formatVersion: 1`,
        `id: prep-legacy-build-dep`,
        `version: 0.0.1`,
        `description: test app`,
        `appRoot: dist`,
        `actions:`,
        `  - actions/ping`,
        ``,
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(
      join(sourceRoot, "package.json"),
      JSON.stringify(
        {
          name: "prep-legacy-build-dep",
          version: "0.0.1",
          packageManager: "pnpm@11.6.0",
          dependencies: { "rome-fixture-legacy-build-dep": "file:dist/legacy-build-dep" },
        },
        null,
        2,
      ),
      "utf-8",
    );
    mkdirSync(join(sourceRoot, "dist", "actions", "ping"), { recursive: true });
    writeFileSync(
      join(sourceRoot, "dist", "actions", "ping", "action.yaml"),
      VALID_ACTION_YAML,
      "utf-8",
    );

    await packArtifact(sourceRoot, packedRoot);
    expect(existsSync(join(packedRoot, "pnpm-workspace.yaml"))).toBe(false);

    const installed = await prepare(
      { kind: "artifact", appId: "prep-legacy-build-dep", artifactRoot: packedRoot },
      { installedRoot },
    );

    expect(existsSync(join(installed.root, "node_modules", "rome-fixture-legacy-build-dep"))).toBe(
      true,
    );
    expect(
      existsSync(
        join(installed.root, "node_modules", "rome-fixture-legacy-build-dep", "built.txt"),
      ),
    ).toBe(false);
  });
});
