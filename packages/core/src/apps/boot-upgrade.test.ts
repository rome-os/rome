import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { installFirstPartyAppsAtBoot, shouldReinstallFirstPartyAppAtBoot } from "./boot-upgrade.js";
import { hashArtifact, packArtifact } from "./packaging/index.js";
import { createTestApps, type TestAppsHarness } from "./test-helpers.js";
import { AppLockfileSchema } from "./lockfile.js";

describe("shouldReinstallFirstPartyAppAtBoot", () => {
  let artifactDir: string;

  beforeEach(async () => {
    artifactDir = await mkdtemp(join(tmpdir(), "rome-boot-upgrade-"));
  });

  afterEach(async () => {
    await rm(artifactDir, { recursive: true, force: true });
  });

  async function writeManifest(version: string): Promise<void> {
    await writeFile(
      join(artifactDir, "app.yaml"),
      `formatVersion: 1\nid: system\nname: System\nversion: ${version}\n`,
    );
  }

  it("reinstalls when the artifact hash differs from the installed hash", async () => {
    await writeManifest("0.3.0");
    const decision = await shouldReinstallFirstPartyAppAtBoot({
      installedHash: "0000000000000000000000000000000000000000000000000000000000000000",
      artifactDir,
    });
    expect(decision.reinstall).toBe(true);
    expect(decision.artifactHash).toBe(await hashArtifact(artifactDir));
  });

  it("skips when the artifact hash matches the installed hash", async () => {
    await writeManifest("0.2.16");
    const currentHash = await hashArtifact(artifactDir);
    const decision = await shouldReinstallFirstPartyAppAtBoot({
      installedHash: currentHash,
      artifactDir,
    });
    expect(decision.reinstall).toBe(false);
    expect(decision.artifactHash).toBe(currentHash);
  });

  it("skips when the installed hash is null (boot loop handles install-if-missing separately)", async () => {
    await writeManifest("0.3.0");
    const decision = await shouldReinstallFirstPartyAppAtBoot({
      installedHash: null,
      artifactDir,
    });
    expect(decision.reinstall).toBe(false);
    expect(decision.artifactHash).toBeNull();
  });

  it("skips and returns null hash when the artifact dir is unreadable", async () => {
    await rm(artifactDir, { recursive: true, force: true });
    const decision = await shouldReinstallFirstPartyAppAtBoot({
      installedHash: "deadbeef",
      artifactDir,
    });
    expect(decision.reinstall).toBe(false);
    expect(decision.artifactHash).toBeNull();
  });

  it("treats every first-party app the same way (no system-only special case)", async () => {
    await writeManifest("0.1.0");
    const decision = await shouldReinstallFirstPartyAppAtBoot({
      installedHash: "stale-hash-from-a-prior-pack",
      artifactDir,
    });
    expect(decision.reinstall).toBe(true);
  });
});

describe("installFirstPartyAppsAtBoot", () => {
  let harness: TestAppsHarness;
  let projectRoot: string;

  beforeEach(async () => {
    harness = await createTestApps();
    projectRoot = await mkdtemp(join(tmpdir(), "rome-first-party-boot-"));
  });

  afterEach(async () => {
    await harness.cleanup();
    await rm(projectRoot, { recursive: true, force: true });
  });

  function manifest(appId: string, version: string): string {
    return [
      "formatVersion: 1",
      `id: ${appId}`,
      `version: ${version}`,
      `description: first-party boot fixture ${appId}`,
      "agents: []",
      "actions: []",
      "skills: []",
      "hooks: []",
      "",
    ].join("\n");
  }

  /** Write an app source and pack it into dist/first-party-artifacts/<appId>. */
  async function packFirstParty(appId: string, version: string): Promise<string> {
    const sourceRoot = join(projectRoot, "src", `${appId}-${version}`);
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(join(sourceRoot, "app.yaml"), manifest(appId, version), "utf-8");
    const outDir = join(projectRoot, "dist", "first-party-artifacts", appId);
    const packed = await packArtifact(sourceRoot, outDir, { appId, clean: true });
    return packed.outDir;
  }

  async function bootInstall() {
    return await installFirstPartyAppsAtBoot({
      appManager: harness.appManager,
      appCatalog: harness.catalog,
      projectRoot,
    });
  }

  /** Absent lockfile means nothing was ever installed — entry is undefined. */
  async function readLockfileEntry(appId: string) {
    let raw: string;
    try {
      raw = await readFile(harness.lockfilePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    return AppLockfileSchema.parse(JSON.parse(raw)).apps[appId];
  }

  it("installs every packed first-party artifact not yet in the lockfile", async () => {
    await packFirstParty("alpha", "0.1.0");
    await packFirstParty("beta", "0.1.0");

    const result = await bootInstall();

    expect(result.firstPartyAppIds).toEqual(["alpha", "beta"]);
    expect(result.installed).toEqual(["alpha", "beta"]);
    expect(result.reinstalled).toEqual([]);
    for (const appId of ["alpha", "beta"]) {
      const entry = await readLockfileEntry(appId);
      expect(entry?.state).toBe("installed");
      expect(entry?.enabled).toBe(true);
      expect(entry?.firstParty).toBe(true);
    }
  });

  it("a second boot with unchanged artifacts is a no-op", async () => {
    await packFirstParty("alpha", "0.1.0");
    await bootInstall();

    const second = await bootInstall();

    expect(second.installed).toEqual([]);
    expect(second.reinstalled).toEqual([]);
    expect(second.skipped).toEqual(["alpha"]);
  });

  it("a user-disabled first-party app stays disabled across a boot reinstall", async () => {
    await packFirstParty("alpha", "0.1.0");
    await bootInstall();
    await harness.appManager.setEnabled("alpha", false);

    await packFirstParty("alpha", "0.2.0");
    const result = await bootInstall();

    expect(result.reinstalled).toEqual(["alpha"]);
    const entry = await readLockfileEntry("alpha");
    expect(entry?.enabled).toBe(false);
    expect(entry?.installedVersion).toBe("0.2.0");
    expect(entry?.firstParty).toBe(true);
  });

  it("re-marks an installed entry that predates the firstParty flag", async () => {
    const artifactDir = await packFirstParty("alpha", "0.1.0");
    // A user-style install of the same artifact records firstParty: false —
    // the shape of lockfiles written before boot owned first-party installs.
    await harness.appManager.install({ source: { mode: "bundle", path: artifactDir } });
    expect((await readLockfileEntry("alpha"))?.firstParty).toBe(false);

    const result = await bootInstall();

    expect(result.reinstalled).toEqual(["alpha"]);
    expect((await readLockfileEntry("alpha"))?.firstParty).toBe(true);
  });

  it("removes an installed first-party app whose packed artifact was dropped", async () => {
    await packFirstParty("alpha", "0.1.0");
    await packFirstParty("beta", "0.1.0");
    await bootInstall();

    await rm(join(projectRoot, "dist", "first-party-artifacts", "beta"), {
      recursive: true,
      force: true,
    });
    const result = await bootInstall();

    expect(result.removed).toEqual(["beta"]);
    expect(await readLockfileEntry("beta")).toBeUndefined();
    expect((await readLockfileEntry("alpha"))?.state).toBe("installed");
  });

  it("fails loudly when no packed artifacts exist at all", async () => {
    await expect(bootInstall()).rejects.toThrow(/pnpm build:apps/);
  });

  it("fails before installing when an artifact's manifest id disagrees with its directory name", async () => {
    const artifactDir = await packFirstParty("alpha", "0.1.0");
    await writeFile(join(artifactDir, "app.yaml"), manifest("impostor", "0.1.0"), "utf-8");

    await expect(bootInstall()).rejects.toThrow(/impostor/);
    expect(await readLockfileEntry("alpha")).toBeUndefined();
    expect(await readLockfileEntry("impostor")).toBeUndefined();
  });
});
