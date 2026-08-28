/**
 * Boot-time legacy migration: an existing profile shaped around
 * per-app `deployment.yaml` + version-keyed bundle dirs must be transparently
 * converted to the lockfile + content-addressed layout the first time the new
 * AppManager boots.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { AppLockfileSchema } from "./lockfile.js";
import { createTestApps, type TestAppsHarness } from "./test-helpers.js";

const APP_YAML = `formatVersion: 1
id: legacyapp
version: 0.0.1
description: legacy migration fixture
agents: []
actions: []
skills: []
hooks: []
`;

const DEPLOYMENT_YAML = `spec:
  source:
    mode: workspace
    path: /tmp/ignored-by-migration
  enabled: true
status:
  phase: Ready
  installedVersion: 0.0.1
`;

interface LegacyDeploymentOptions {
  source?: string;
  enabled?: boolean;
  phase?: string;
  installedVersion?: string | null;
  integrity?: string;
}

function legacyDeploymentYaml(opts: LegacyDeploymentOptions = {}): string {
  const source =
    opts.source ?? `  source:\n    mode: workspace\n    path: /tmp/ignored-by-migration`;
  const enabled = opts.enabled ?? true;
  const phase = opts.phase ?? "Ready";
  const installedVersionLine =
    opts.installedVersion === null
      ? ""
      : `\n  installedVersion: ${opts.installedVersion ?? "0.0.1"}`;
  const integrityLine = opts.integrity ? `\n  integrity: ${opts.integrity}` : "";
  return `spec:\n${source}\n  enabled: ${enabled}\nstatus:\n  phase: ${phase}${installedVersionLine}${integrityLine}\n`;
}

async function writeLegacyAppDir(
  legacyAppsDir: string,
  appId: string,
  version: string,
  opts: { deploymentYaml?: string; skipBundle?: boolean } = {},
): Promise<void> {
  const appDir = join(legacyAppsDir, appId);
  if (!opts.skipBundle) {
    const versionDir = join(appDir, version);
    await mkdir(versionDir, { recursive: true });
    await writeFile(join(versionDir, "app.yaml"), APP_YAML, "utf-8");
    await symlink(version, join(appDir, "active"));
  } else {
    await mkdir(appDir, { recursive: true });
  }
  await writeFile(join(appDir, "deployment.yaml"), opts.deploymentYaml ?? DEPLOYMENT_YAML, "utf-8");
}

describe("AppManager.boot legacy migration", () => {
  let harness: TestAppsHarness;

  beforeEach(async () => {
    harness = await createTestApps();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("converts deployment.yaml + version-keyed bundle into lockfile + content-addressed dir", async () => {
    const legacyAppsDir = join(harness.profileRoot, "apps");
    await writeLegacyAppDir(legacyAppsDir, "legacyapp", "0.0.1");

    expect(existsSync(harness.lockfilePath)).toBe(false);

    const result = await harness.appManager.boot();

    expect(existsSync(harness.lockfilePath)).toBe(true);
    expect(result.appCount).toBe(1);
    expect(result.brokenApps).toEqual([]);

    const lockfile = AppLockfileSchema.parse(
      JSON.parse(await readFile(harness.lockfilePath, "utf-8")),
    );
    const entry = lockfile.apps.legacyapp;
    expect(entry).toBeDefined();
    expect(entry.state).toBe("installed");
    expect(entry.installedHash).toMatch(/^[a-f0-9]{64}$/);
    expect(entry.installedVersion).toBe("0.0.1");

    const activeTarget = await readlink(join(harness.installedRoot, "legacyapp", "active"));
    expect(activeTarget).toBe(entry.installedHash);
    expect(
      existsSync(join(harness.installedRoot, "legacyapp", entry.installedHash!, "app.yaml")),
    ).toBe(true);

    expect(existsSync(join(legacyAppsDir, "legacyapp", "deployment.yaml"))).toBe(false);
  });

  it("is idempotent — second boot after migration is a no-op", async () => {
    await writeLegacyAppDir(join(harness.profileRoot, "apps"), "legacyapp", "0.0.1");
    const first = await harness.appManager.boot();
    expect(first.appCount).toBe(1);

    const lockBefore = await readFile(harness.lockfilePath, "utf-8");
    const second = await harness.appManager.boot();
    const lockAfter = await readFile(harness.lockfilePath, "utf-8");

    expect(second.appCount).toBe(1);
    expect(second.brokenApps).toEqual([]);
    // Byte-equal: catches both content drift and a regressed early-return
    // guard that would re-run the migrator and bump per-entry `updatedAt`.
    expect(lockAfter).toBe(lockBefore);
  });

  it("creates an empty lockfile on a fresh profile without invoking the migrator", async () => {
    expect(existsSync(join(harness.profileRoot, "apps"))).toBe(false);
    const result = await harness.appManager.boot();
    expect(result.appCount).toBe(0);

    const lockfile = AppLockfileSchema.parse(
      JSON.parse(await readFile(harness.lockfilePath, "utf-8")),
    );
    expect(lockfile.apps).toEqual({});
    expect(existsSync(harness.installedRoot)).toBe(false);
  });

  it("rewrites legacy appstore source (url → listingId) and pins contentHash from status.integrity", async () => {
    const integrity = "a".repeat(64);
    await writeLegacyAppDir(join(harness.profileRoot, "apps"), "legacyapp", "0.0.1", {
      deploymentYaml: legacyDeploymentYaml({
        source: `  source:\n    mode: appstore\n    url: example/legacyapp\n    version: 0.0.1`,
        integrity,
      }),
    });

    await harness.appManager.boot();

    const lockfile = AppLockfileSchema.parse(
      JSON.parse(await readFile(harness.lockfilePath, "utf-8")),
    );
    const entry = lockfile.apps.legacyapp;
    expect(entry.state).toBe("installed");
    expect(entry.source).toEqual({
      mode: "appstore",
      listingId: "example/legacyapp",
      version: "0.0.1",
      contentHash: integrity,
    });
  });

  it("preserves spec.enabled=false across migration so disabled apps stay disabled", async () => {
    await writeLegacyAppDir(join(harness.profileRoot, "apps"), "legacyapp", "0.0.1", {
      deploymentYaml: legacyDeploymentYaml({ enabled: false }),
    });

    await harness.appManager.boot();

    const lockfile = AppLockfileSchema.parse(
      JSON.parse(await readFile(harness.lockfilePath, "utf-8")),
    );
    expect(lockfile.apps.legacyapp.enabled).toBe(false);
    expect(lockfile.apps.legacyapp.state).toBe("installed");
  });

  it("marks non-Ready legacy apps as failed without relocating their bundle", async () => {
    await writeLegacyAppDir(join(harness.profileRoot, "apps"), "legacyapp", "0.0.1", {
      deploymentYaml: legacyDeploymentYaml({
        phase: "Installing",
        installedVersion: null,
      }),
    });

    await harness.appManager.boot();

    const lockfile = AppLockfileSchema.parse(
      JSON.parse(await readFile(harness.lockfilePath, "utf-8")),
    );
    const entry = lockfile.apps.legacyapp;
    expect(entry.state).toBe("failed");
    expect(entry.installedHash).toBeNull();
    expect(entry.installedVersion).toBeNull();
    expect(existsSync(join(harness.installedRoot, "legacyapp", "active"))).toBe(false);
  });

  it("flags Ready legacy apps whose bundle dir is missing as broken with MIGRATE_MISSING_BUNDLE", async () => {
    await writeLegacyAppDir(join(harness.profileRoot, "apps"), "legacyapp", "0.0.1", {
      skipBundle: true,
    });

    await harness.appManager.boot();

    const lockfile = AppLockfileSchema.parse(
      JSON.parse(await readFile(harness.lockfilePath, "utf-8")),
    );
    const entry = lockfile.apps.legacyapp;
    expect(entry.state).toBe("broken");
    expect(entry.lastError?.code).toBe("MIGRATE_MISSING_BUNDLE");
    expect(entry.installedVersion).toBe("0.0.1");
    expect(entry.installedHash).toBeNull();
    expect(existsSync(join(harness.installedRoot, "legacyapp", "active"))).toBe(false);
  });
});
