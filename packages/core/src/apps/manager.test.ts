import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { AppManagerError } from "./manager.js";
import { PACKED_ARTIFACT_SENTINEL, packArtifact, packBundle } from "./packaging/index.js";
import { remixApp } from "./remix.js";
import { createTestApps, type TestAppsHarness } from "./test-helpers.js";
import { AppLockfileSchema, APPS_LOCKFILE_SCHEMA_VERSION, type SpecSource } from "./lockfile.js";

const SAMPLE_MANIFEST = `formatVersion: 1
id: testapp
version: 0.0.1
description: behavioral test fixture
agents: []
actions: []
skills: []
hooks: []
`;

async function makeWorkspace(root: string, manifest: string = SAMPLE_MANIFEST): Promise<string> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "app.yaml"), manifest, "utf-8");
  return root;
}

async function packWorkspace(workspaceRoot: string): Promise<string> {
  const packedRoot = `${workspaceRoot}.packed`;
  const result = await packArtifact(workspaceRoot, packedRoot);
  return result.outDir;
}

async function listInstalledHashDirs(harness: TestAppsHarness, appId: string): Promise<string[]> {
  const appDir = join(harness.installedRoot, appId);
  const entries = await readdir(appDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

async function readLockfile(harness: TestAppsHarness) {
  const raw = await readFile(harness.lockfilePath, "utf-8");
  return AppLockfileSchema.parse(JSON.parse(raw));
}

describe("AppManager", () => {
  let harness: TestAppsHarness;
  let workspaceRoot: string;
  let packedRoot: string;
  const bundleFetcher = rs.fn<import("./store-bundle.js").BundleFetcher>();

  beforeEach(async () => {
    bundleFetcher.mockReset();
    harness = await createTestApps({ bundleFetcher });
    workspaceRoot = await makeWorkspace(join(harness.profileRoot, "fixture-app"));
    packedRoot = await packWorkspace(workspaceRoot);
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  async function storeSource(version = "0.0.1") {
    const listingId = "@alice/calendar";
    const root = await makeWorkspace(
      join(harness.profileRoot, `store-${version}`),
      SAMPLE_MANIFEST.replace("id: testapp", `id: "${listingId}"`).replace(
        "version: 0.0.1",
        `version: ${version}`,
      ) + "includeSource: true\n",
    );
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "main.txt"), "Published source\n");
    const bytes = await packBundle(await packWorkspace(root));
    bundleFetcher.mockResolvedValue(bytes);
    return {
      mode: "appstore" as const,
      listingId,
      version,
      contentHash: createHash("sha256").update(bytes).digest("hex"),
    };
  }

  it.each([
    "absent",
    "matching",
    "different",
  ] as const)("remixes a Store source with a %s installation without changing installed apps", async (state) => {
    const source = await storeSource();
    if (state !== "absent") await harness.appManager.install({ source, enabled: false });
    const requested = state === "different" ? await storeSource("2.0.0") : source;
    const before = existsSync(harness.lockfilePath)
      ? await readFile(harness.lockfilePath, "utf8")
      : null;
    const install = rs.spyOn(harness.appManager, "install");
    const uninstall = rs.spyOn(harness.appManager, "uninstall");
    bundleFetcher.mockClear();
    const result = await remixApp(
      {
        appId: "ray-calendar",
        name: "@ray/calendar",
        from: {
          listingId: requested.listingId,
          version: requested.version,
          contentHash: requested.contentHash,
        },
      },
      {
        appManager: harness.appManager,
        appCatalog: harness.catalog,
        bundleFetcher,
        installedRoot: harness.installedRoot,
        authoringRoot: join(harness.profileRoot, "authoring"),
      },
    );
    expect(await readFile(join(result.rootPath, "src", "main.txt"), "utf8")).toBe(
      "Published source\n",
    );
    expect(await readFile(join(result.rootPath, "app.yaml"), "utf8")).toContain(
      `version: ${requested.version}`,
    );
    expect(
      existsSync(harness.lockfilePath) ? await readFile(harness.lockfilePath, "utf8") : null,
    ).toBe(before);
    expect(install).not.toHaveBeenCalled();
    expect(uninstall).not.toHaveBeenCalled();
    expect(harness.catalog.get("ray-calendar")).toBeNull();
    expect(bundleFetcher).toHaveBeenCalledTimes(state === "matching" ? 0 : 1);
    if (state === "absent")
      expect(await harness.appManager.readLockfileEntry(source.listingId)).toBeNull();
  });

  it("install + re-install of the same source is a cache hit on the same hash", async () => {
    const source: SpecSource = { mode: "bundle", path: packedRoot };
    const first = await harness.appManager.install({ source });
    expect(first.appId).toBe("testapp");
    expect(first.state).toBe("installed");
    expect(first.installedHash).toMatch(/^[a-f0-9]{64}$/);

    const second = await harness.appManager.install({ source });
    expect(second.state).toBe("installed");
    expect(second.installedHash).toBe(first.installedHash);
    expect(second.installedVersion).toBe("0.0.1");

    const lockfile = await readLockfile(harness);
    expect(lockfile.schemaVersion).toBe(APPS_LOCKFILE_SCHEMA_VERSION);
    expect(lockfile.apps.testapp.state).toBe("installed");
    expect(lockfile.apps.testapp.installedHash).toBe(first.installedHash);
  });

  it("keeps only the active installed hash plus one old cached hash", async () => {
    const sources: SpecSource[] = [];
    for (const version of ["one", "two", "three"]) {
      const root = await makeWorkspace(join(harness.profileRoot, `fixture-${version}`));
      await writeFile(join(root, "README.md"), `${version}\n`, "utf-8");
      sources.push({ mode: "bundle", path: await packWorkspace(root) });
    }

    const first = await harness.appManager.install({ source: sources[0] });
    expect(first.state).toBe("installed");
    const second = await harness.appManager.install({ source: sources[1] });
    expect(second.state).toBe("installed");
    const third = await harness.appManager.install({ source: sources[2] });
    expect(third.state).toBe("installed");

    const installedHashes = await listInstalledHashDirs(harness, "testapp");
    expect(installedHashes).toContain(third.installedHash);
    expect(installedHashes).toHaveLength(2);
    expect(installedHashes).not.toContain(first.installedHash);
  });

  it("rejects an install from a non-existent path without touching a healthy install", async () => {
    const source: SpecSource = { mode: "bundle", path: packedRoot };
    const ok = await harness.appManager.install({ source });
    expect(ok.state).toBe("installed");

    const badSource: SpecSource = {
      mode: "bundle",
      path: join(harness.profileRoot, "does-not-exist"),
    };
    await expect(harness.appManager.install({ source: badSource })).rejects.toMatchObject({
      name: "AppManagerError",
      code: "ARTIFACT_INVALID",
    });

    const lockfile = await readLockfile(harness);
    expect(lockfile.apps.testapp.state).toBe("installed");
    expect(lockfile.apps.testapp.installedHash).toBe(ok.installedHash);
    expect(lockfile.apps.testapp.lastError).toBeNull();
  });

  it("rejects a packed artifact missing a manifest-declared action (corrupted after pack)", async () => {
    // Pack a valid workspace, then delete the action from the artifact —
    // the shape gate passes (sentinel present) and deep validation must
    // still catch the missing declared output.
    const srcRoot = join(harness.profileRoot, "unbuilt-app-src");
    await mkdir(join(srcRoot, "actions", "echo"), { recursive: true });
    await writeFile(
      join(srcRoot, "app.yaml"),
      [
        "formatVersion: 1",
        "id: testapp",
        "version: 0.0.1",
        "description: declares an action",
        "actions:",
        "  - actions/echo",
        "",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      join(srcRoot, "actions", "echo", "action.yaml"),
      [
        "name: echo",
        "type: custom",
        "description: echo",
        "complexity: simple",
        "speed: fast",
        "reliability: high",
        "sideEffects: read-only",
        "",
      ].join("\n"),
      "utf-8",
    );
    const corrupted = await packWorkspace(srcRoot);
    await rm(join(corrupted, "actions", "echo"), { recursive: true, force: true });

    await expect(
      harness.appManager.install({
        source: { mode: "bundle", path: corrupted },
      }),
    ).rejects.toMatchObject({
      code: "ARTIFACT_INVALID",
      message: expect.stringMatching(/missing action .*run the app's build step/s),
    });

    expect(existsSync(harness.lockfilePath)).toBe(false);
  });

  it("rejects a remixed bundle whose action identity still conflicts with an installed app", async () => {
    const writeActionWorkspace = async (
      root: string,
      options: { id: string; actionName: string; remix?: boolean },
    ) => {
      await mkdir(join(root, "actions", "shared"), { recursive: true });
      await writeFile(
        join(root, "app.yaml"),
        [
          "formatVersion: 1",
          `id: ${options.id}`,
          "version: 1.0.0",
          `description: ${options.id}`,
          ...(options.remix ? ["remix:", "  listing: '@source/calendar'", "  version: 1.0.0"] : []),
          "actions:",
          "  - actions/shared",
          "",
        ].join("\n"),
      );
      await writeFile(
        join(root, "actions", "shared", "action.yaml"),
        [
          `name: ${options.actionName}`,
          "type: custom",
          "description: shared action",
          "complexity: simple",
          "speed: fast",
          "reliability: high",
          "sideEffects: read-only",
          "",
        ].join("\n"),
      );
    };

    const sourceRoot = join(harness.profileRoot, "source-with-shared-action");
    await writeActionWorkspace(sourceRoot, { id: "sourceapp", actionName: "shared_action" });
    const sourceResult = await harness.appManager.install({
      source: { mode: "bundle", path: await packWorkspace(sourceRoot) },
    });
    expect(sourceResult.state).toBe("installed");

    const remixRoot = join(harness.profileRoot, "remix-with-shared-action");
    await writeActionWorkspace(remixRoot, {
      id: "remixapp",
      actionName: "shared_action",
      remix: true,
    });

    await expect(
      harness.appManager.install({
        source: { mode: "bundle", path: await packWorkspace(remixRoot) },
      }),
    ).rejects.toMatchObject({
      name: "AppManagerError",
      code: "ARTIFACT_INVALID",
      message: expect.stringContaining("REMIX_ARTIFACT_CONFLICT"),
    });
    expect((await readLockfile(harness)).apps.remixapp).toBeUndefined();
  });

  it("rejects a packed artifact whose declared web bundle is missing (corrupted after pack)", async () => {
    const srcRoot = join(harness.profileRoot, "unbuilt-web-app-src");
    await mkdir(join(srcRoot, "dist", "web"), { recursive: true });
    await writeFile(
      join(srcRoot, "app.yaml"),
      [
        "formatVersion: 1",
        "id: testapp",
        "version: 0.0.1",
        "description: declares a web bundle",
        "appRoot: dist",
        "web:",
        "  manifest: web/manifest.json",
        "",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      join(srcRoot, "dist", "web", "manifest.json"),
      JSON.stringify({ entry: "index.js" }),
      "utf-8",
    );
    await writeFile(join(srcRoot, "dist", "web", "index.js"), "export default {};\n", "utf-8");
    const corrupted = await packWorkspace(srcRoot);
    await rm(join(corrupted, "dist", "web", "manifest.json"), { force: true });

    await expect(
      harness.appManager.install({
        source: { mode: "bundle", path: corrupted },
      }),
    ).rejects.toMatchObject({
      code: "ARTIFACT_INVALID",
      message: expect.stringMatching(/missing web manifest/),
    });

    expect(existsSync(harness.lockfilePath)).toBe(false);
  });

  it("a failure inside materialize records state=failed and preserves prior hash", async () => {
    const source: SpecSource = { mode: "bundle", path: packedRoot };
    const ok = await harness.appManager.install({ source });
    expect(ok.state).toBe("installed");

    const realMaterialize = harness.installer.materialize.bind(harness.installer);
    harness.installer.materialize = async () => {
      throw new Error("simulated disk failure during materialize");
    };
    try {
      const failed = await harness.appManager.install({ source });
      expect(failed.state).toBe("failed");
      expect(failed.installedHash).toBe(ok.installedHash);
      expect(failed.installedVersion).toBe(ok.installedVersion);

      const lockfile = await readLockfile(harness);
      expect(lockfile.apps.testapp.state).toBe("failed");
      expect(lockfile.apps.testapp.installedHash).toBe(ok.installedHash);
      expect(lockfile.apps.testapp.lastError).not.toBeNull();
    } finally {
      harness.installer.materialize = realMaterialize;
    }
  });

  it("uninstall always drops the lockfile entry", async () => {
    const source: SpecSource = { mode: "bundle", path: packedRoot };
    await harness.appManager.install({ source });

    const result = await harness.appManager.uninstall("testapp");
    expect(result.alreadyAbsent).toBe(false);

    const lockfile = await readLockfile(harness);
    expect(lockfile.apps.testapp).toBeUndefined();
  });

  // Regression: in dev (`tsx watch`) the daemon was restarted mid-uninstall by
  // its own `rm -rf installed/<appId>/` unlinking modules tsx was tracking.
  // With teardown running BEFORE the lockfile drop, the resurrected daemon
  // saw "state: installed" pointing at a half-deleted bundle and surfaced
  // `PROBE_FAILED: active symlink missing`. The fix drops the lockfile entry
  // first, so a crashed teardown leaves the lockfile clean and the orphan
  // dir gets swept on next boot.
  it("uninstall drops lockfile entry before tearing down bundle on disk", async () => {
    const source: SpecSource = { mode: "bundle", path: packedRoot };
    const install = await harness.appManager.install({ source });
    const installedAppDir = join(harness.installedRoot, "testapp");
    expect(existsSync(join(installedAppDir, "active"))).toBe(true);

    let sawDropBeforeTeardown = false;
    let teardownCount = 0;
    const realTearDown = harness.installer.tearDown.bind(harness.installer);
    harness.installer.tearDown = async (appId: string) => {
      teardownCount += 1;
      const raw = await readFile(harness.lockfilePath, "utf-8");
      const lockfile = JSON.parse(raw) as { apps: Record<string, unknown> };
      sawDropBeforeTeardown = lockfile.apps[appId] === undefined;
      return await realTearDown(appId);
    };
    try {
      const result = await harness.appManager.uninstall("testapp");
      expect(result.alreadyAbsent).toBe(false);
      expect(teardownCount).toBe(1);
      expect(sawDropBeforeTeardown).toBe(true);
      expect(install.installedHash).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      harness.installer.tearDown = realTearDown;
    }

    expect(existsSync(installedAppDir)).toBe(false);
    const lockfile = await readLockfile(harness);
    expect(lockfile.apps.testapp).toBeUndefined();
  });

  // An interrupted teardown leaves `installed/<appId>/` on disk with no
  // matching lockfile entry. Boot must NOT sweep it: a blanket "anything
  // not in the lockfile is garbage" rule wipes every cached bundle when
  // the lockfile is freshly empty (e.g. after `discardNonCurrentLockfile`).
  // The dangling dir is harmless — boot only probes lockfile entries, and
  // a re-install of the same appId is a content-addressed cache hit on
  // the existing dir.
  it("boot leaves installed/<appId> dirs not referenced by the lockfile alone", async () => {
    const source: SpecSource = { mode: "bundle", path: packedRoot };
    await harness.appManager.install({ source });
    const installedAppDir = join(harness.installedRoot, "testapp");
    expect(existsSync(installedAppDir)).toBe(true);

    const raw = await readFile(harness.lockfilePath, "utf-8");
    const parsed = JSON.parse(raw) as { apps: Record<string, unknown> };
    delete parsed.apps.testapp;
    await writeFile(harness.lockfilePath, JSON.stringify(parsed));

    const fresh = await createTestApps({ profileRoot: harness.profileRoot });
    try {
      const boot = await fresh.appManager.boot();
      expect(boot.brokenApps).not.toContain("testapp");
      expect(boot.appCount).toBe(0);
      expect(existsSync(installedAppDir)).toBe(true);
    } finally {
      await fresh.cleanup();
    }
  });

  it("system app cannot be uninstalled or disabled", async () => {
    await expect(harness.appManager.uninstall("system")).rejects.toBeInstanceOf(AppManagerError);
    await expect(harness.appManager.setEnabled("system", false)).rejects.toBeInstanceOf(
      AppManagerError,
    );
  });

  it("setEnabled flips bool without re-running installer", async () => {
    const source: SpecSource = { mode: "bundle", path: packedRoot };
    await harness.appManager.install({ source });

    await harness.appManager.setEnabled("testapp", false);
    let lockfile = await readLockfile(harness);
    expect(lockfile.apps.testapp.enabled).toBe(false);

    await harness.appManager.setEnabled("testapp", true);
    lockfile = await readLockfile(harness);
    expect(lockfile.apps.testapp.enabled).toBe(true);
  });

  it("disabled app keeps display metadata without loading runtime artifacts", async () => {
    const root = await makeWorkspace(
      join(harness.profileRoot, "fixture-icon-app"),
      `formatVersion: 1
id: testapp
name: Test App
version: 0.0.1
description: behavioral test fixture
icon: icon.svg
agents: []
actions: []
skills: []
hooks: []
`,
    );
    await writeFile(join(root, "icon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>", "utf-8");
    const source: SpecSource = { mode: "bundle", path: await packWorkspace(root) };
    await harness.appManager.install({ source });

    await harness.appManager.setEnabled("testapp", false);

    const view = harness.catalog.get("testapp");
    expect(view?.displayName).toBe("Test App");
    expect(view?.iconAbsolutePath).toMatch(/icon\.svg$/);
    // Display metadata must not make the disabled app look loaded: every
    // isResolvedApp guard keys off `manifest`, and listResolved stays empty.
    expect(view && "manifest" in view).toBe(false);
    expect(harness.catalog.listResolved().map((app) => app.appId)).not.toContain("testapp");

    await harness.appManager.setEnabled("testapp", true);
    const reEnabled = harness.catalog.get("testapp");
    expect(reEnabled && "manifest" in reEnabled).toBe(true);
    expect(reEnabled?.displayName).toBe("Test App");
  });

  it("disables and unloads an app when a declared runtime artifact has disappeared", async () => {
    const root = await makeWorkspace(
      join(harness.profileRoot, "fixture-damaged-icon-app"),
      `formatVersion: 1
id: testapp
name: Test App
version: 0.0.1
description: behavioral test fixture
icon: icon.svg
agents: []
actions:
  - actions/echo
skills: []
hooks: []
`,
    );
    await mkdir(join(root, "actions", "echo"), { recursive: true });
    await writeFile(
      join(root, "actions", "echo", "action.yaml"),
      `name: echo
type: custom
description: echo
complexity: simple
speed: fast
reliability: high
sideEffects: read-only
`,
      "utf-8",
    );
    await writeFile(join(root, "icon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>", "utf-8");
    const source: SpecSource = { mode: "bundle", path: await packWorkspace(root) };
    const installed = await harness.appManager.install({ source });
    const subscriber = harness.recordSubscribed("unloadRecorder");

    await rm(join(harness.installedRoot, "testapp", installed.installedHash!, "actions", "echo"), {
      recursive: true,
      force: true,
    });

    await expect(harness.appManager.setEnabled("testapp", false)).resolves.toBeUndefined();

    const lockfile = await readLockfile(harness);
    expect(lockfile.apps.testapp.enabled).toBe(false);
    const view = harness.catalog.get("testapp");
    expect(view).toMatchObject({
      appId: "testapp",
      enabled: false,
      displayName: "Test App",
    });
    expect(view && "manifest" in view).toBe(false);
    expect(harness.catalog.listResolved().map((app) => app.appId)).not.toContain("testapp");
    const unloadEvent = subscriber.events.at(-1);
    expect(unloadEvent).toMatchObject({
      appId: "testapp",
      change: "changed",
      current: { enabled: false, displayName: "Test App" },
    });
    expect(unloadEvent?.current && "manifest" in unloadEvent.current).toBe(false);
  });

  it("subscriber receives added/changed events in invocation order", async () => {
    const source: SpecSource = { mode: "bundle", path: packedRoot };
    const a = harness.recordSubscribed("first");
    const b = harness.recordSubscribed("second");

    await harness.appManager.install({ source });

    expect(a.events.length).toBeGreaterThanOrEqual(1);
    expect(b.events.length).toBeGreaterThanOrEqual(1);
    const finalA = a.events[a.events.length - 1];
    const finalB = b.events[b.events.length - 1];
    expect(finalA.appId).toBe("testapp");
    expect(finalB.appId).toBe("testapp");
    expect(finalA.current?.state).toBe("installed");
  });

  it("does not resolve install until the active bundle reaches catalog subscribers", async () => {
    const source: SpecSource = { mode: "bundle", path: packedRoot };
    let releaseInstalledSubscriber!: () => void;
    const installedSubscriberReleased = new Promise<void>((resolve) => {
      releaseInstalledSubscriber = resolve;
    });
    let installedSubscriberReached!: () => void;
    const installedSubscriberWasReached = new Promise<void>((resolve) => {
      installedSubscriberReached = resolve;
    });

    harness.catalog.subscribe(async function installedBundleBarrier(event) {
      if (event.current?.state !== "installed") return;
      installedSubscriberReached();
      await installedSubscriberReleased;
    });

    let installSettled = false;
    const install = harness.appManager.install({ source }).finally(() => {
      installSettled = true;
    });

    await installedSubscriberWasReached;
    let activeHash: string | null = null;
    try {
      expect(installSettled).toBe(false);

      activeHash = await harness.installer.readActiveTarget("testapp");
      expect(activeHash).toMatch(/^[a-f0-9]{64}$/);
      expect(harness.catalog.get("testapp")).toMatchObject({
        state: "installed",
        installedHash: activeHash,
      });
    } finally {
      releaseInstalledSubscriber();
    }

    const result = await install;
    expect(result.installedHash).toBe(activeHash);
    expect(installSettled).toBe(true);
  });

  it("boot probes active symlink and marks broken when hash drifts", async () => {
    const source: SpecSource = { mode: "bundle", path: packedRoot };
    await harness.appManager.install({ source });

    // Corrupt active by replacing the lockfile-recorded hash with a fake value.
    const raw = await readFile(harness.lockfilePath, "utf-8");
    const parsed = JSON.parse(raw);
    parsed.apps.testapp.installedHash = "f".repeat(64);
    await writeFile(harness.lockfilePath, JSON.stringify(parsed));

    const fresh = await createTestApps({ profileRoot: harness.profileRoot });
    try {
      const boot = await fresh.appManager.boot();
      expect(boot.brokenApps).toContain("testapp");
    } finally {
      await fresh.cleanup();
    }
  });

  it("rejects a source workspace whose manifest declares an invalid app id", async () => {
    const root = join(harness.profileRoot, "bad-id-app");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "app.yaml"),
      SAMPLE_MANIFEST.replace("id: testapp", "id: BadAppID"),
      "utf-8",
    );
    await expect(
      harness.appManager.install({ source: { mode: "source", path: root } }),
    ).rejects.toMatchObject({
      name: "AppManagerError",
      code: "ARTIFACT_INVALID",
      message: expect.stringMatching(/BadAppID/),
    });
    expect(existsSync(harness.lockfilePath)).toBe(false);
  });

  it("install rejects a bundle source that isn't a packed artifact", async () => {
    const rawDir = join(harness.profileRoot, "raw-no-manifest");
    await mkdir(rawDir, { recursive: true });
    await writeFile(join(rawDir, "src.ts"), "// not a packed artifact\n", "utf-8");

    await expect(
      harness.appManager.install({
        source: { mode: "bundle", path: rawDir },
      }),
    ).rejects.toMatchObject({
      code: "ARTIFACT_INVALID",
      message: expect.stringMatching(/not a packed app artifact[\s\S]*mode: "source"/),
    });

    expect(existsSync(harness.lockfilePath)).toBe(false);
  });

  // Pre-#314 dev profiles have an `apps.lock.json` written under the prior
  // `schemaVersion: 2` shape (string `source: "seed:first_party"`, raw `hash`,
  // etc.). Boot must rename it aside and start clean so install/seed paths
  // don't trip on `LockfileTopLevelError`.
  it("boot discards a non-current schemaVersion lockfile and starts clean", async () => {
    const legacyLockfile = JSON.stringify({
      schemaVersion: 2,
      apps: {
        legacy: {
          source: "seed:first_party",
          enabled: true,
          version: "0.0.1",
          hash: "0".repeat(64),
        },
      },
    });
    await writeFile(harness.lockfilePath, legacyLockfile, "utf-8");

    const fresh = await createTestApps({ profileRoot: harness.profileRoot });
    try {
      const boot = await fresh.appManager.boot();
      expect(boot.appCount).toBe(0);

      const lockfile = await readLockfile(fresh);
      expect(lockfile.schemaVersion).toBe(APPS_LOCKFILE_SCHEMA_VERSION);
      expect(Object.keys(lockfile.apps)).toEqual([]);

      // Backup file is named with a `.bak-<timestamp>-<pid>` suffix.
      const profileEntries = await readdir(harness.profileRoot);
      const backups = profileEntries.filter((name) => name.startsWith("apps.lock.json.bak-"));
      expect(backups).toHaveLength(1);
      const backupRaw = await readFile(join(harness.profileRoot, backups[0]), "utf-8");
      expect(JSON.parse(backupRaw)).toMatchObject({ schemaVersion: 2 });

      // Subsequent installs through the same manager must work — the legacy
      // file no longer blocks `readLockfileWithEntryIsolation`.
      const result = await fresh.appManager.install({
        source: { mode: "bundle", path: packedRoot },
      });
      expect(result.state).toBe("installed");
    } finally {
      await fresh.cleanup();
    }
  });

  // Genuine corruption (missing schemaVersion, malformed shape) must still
  // surface loudly — only stale-but-shaped lockfiles get auto-discarded.
  it("boot throws on a malformed lockfile rather than silently discarding", async () => {
    await writeFile(
      harness.lockfilePath,
      JSON.stringify({ schemaVersion: "three", apps: {} }),
      "utf-8",
    );

    const fresh = await createTestApps({ profileRoot: harness.profileRoot });
    try {
      await expect(fresh.appManager.boot()).rejects.toThrow(/unsupported schemaVersion/);
    } finally {
      await fresh.cleanup();
    }
  });

  describe("one-step source mode", () => {
    // A scaffold-shaped workspace: app.yaml at the root plus a `src/` tree —
    // the shape `op: "create"` materializes. No package.json, so the daemon's
    // build stage is a no-op and the test exercises pack + install.
    async function makeSourceWorkspace(root: string): Promise<string> {
      await makeWorkspace(root);
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "index.ts"), "export {};\n", "utf-8");
      return root;
    }

    it("installs straight from a source workspace and records the source spec", async () => {
      const repo = await makeSourceWorkspace(join(harness.profileRoot, "one-step-app"));
      const source: SpecSource = { mode: "source", path: repo };

      const result = await harness.appManager.install({ source });
      expect(result.state).toBe("installed");
      expect(result.installedVersion).toBe("0.0.1");

      // The daemon packed into the conventional in-repo artifact dir.
      expect(existsSync(join(repo, ".rome", "artifact", "app.yaml"))).toBe(true);

      // The lockfile pins the SOURCE repo, not the packed artifact, so every
      // re-install rebuilds from source.
      const lockfile = await readLockfile(harness);
      expect(lockfile.apps.testapp.source).toEqual({ mode: "source", path: repo });
    });

    it("re-installing an unchanged source converges to the same installed hash", async () => {
      const repo = await makeSourceWorkspace(join(harness.profileRoot, "one-step-stable"));
      const source: SpecSource = { mode: "source", path: repo };

      const first = await harness.appManager.install({ source });
      const second = await harness.appManager.install({ source });
      expect(second.installedHash).toBe(first.installedHash);
    });

    it("a failed source build leaves the previous installed version running and untouched", async () => {
      const repo = await makeSourceWorkspace(join(harness.profileRoot, "one-step-buildfail"));
      const source: SpecSource = { mode: "source", path: repo };

      const first = await harness.appManager.install({ source });
      expect(first.state).toBe("installed");

      // Make the next build fail deterministically: give the workspace a
      // build script and put it "inside the Rome monorepo" via the project
      // root override, so buildSourceWorkspace trips its pnpm guard.
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({ name: "testapp", scripts: { build: "false" } }),
        "utf-8",
      );
      rs.stubEnv("ROME_PROJECT_ROOT", harness.profileRoot);
      try {
        await expect(harness.appManager.install({ source })).rejects.toMatchObject({
          code: "ARTIFACT_INVALID",
          message: expect.stringMatching(/pnpm build:apps/),
        });
      } finally {
        rs.unstubAllEnvs();
      }

      // The failed build never transitioned anything: the lockfile still
      // records the first install and the catalog still resolves the app.
      const lockfile = await readLockfile(harness);
      expect(lockfile.apps.testapp.state).toBe("installed");
      expect(lockfile.apps.testapp.installedHash).toBe(first.installedHash);
      expect(lockfile.apps.testapp.lastError).toBeNull();
      await harness.catalog.refresh("testapp");
      const resolved = harness.catalog.listResolved().find((a) => a.appId === "testapp");
      expect(resolved?.state).toBe("installed");
    });

    it("rejects mode source pointed at a packed artifact, naming the bundle alternative", async () => {
      await expect(
        harness.appManager.install({
          source: { mode: "source", path: packedRoot },
        }),
      ).rejects.toMatchObject({
        code: "ARTIFACT_INVALID",
        message: expect.stringMatching(/packed artifact, not a source workspace[\s\S]*"bundle"/),
      });
      expect(existsSync(harness.lockfilePath)).toBe(false);
    });

    it("rejects mode bundle pointed at a source workspace, naming the source install", async () => {
      const repo = await makeSourceWorkspace(join(harness.profileRoot, "shaped-like-source"));
      await expect(
        harness.appManager.install({
          source: { mode: "bundle", path: repo },
        }),
      ).rejects.toMatchObject({
        code: "ARTIFACT_INVALID",
        message: expect.stringMatching(/source workspace, not a packed artifact[\s\S]*"source"/),
      });
      expect(existsSync(harness.lockfilePath)).toBe(false);
    });

    it("rejects mode bundle on a marker-free dir that fails artifact validation", async () => {
      // No pack sentinel and no source markers, and deep validation fails
      // (declares an action that does not exist): the rejection offers both
      // corrective paths — source install and re-pack.
      const repo = join(harness.profileRoot, "marker-free");
      await makeWorkspace(
        repo,
        [
          "formatVersion: 1",
          "id: testapp",
          "version: 0.0.1",
          "description: declares an action that does not exist",
          "actions:",
          "  - actions/echo",
          "",
        ].join("\n"),
      );
      await expect(
        harness.appManager.install({
          source: { mode: "bundle", path: repo },
        }),
      ).rejects.toMatchObject({
        code: "ARTIFACT_INVALID",
        message: expect.stringMatching(/not a recognizably packed artifact[\s\S]*mode: "source"/),
      });
      expect(existsSync(harness.lockfilePath)).toBe(false);
    });

    it("installs a legacy pre-sentinel artifact via mode bundle when it validates", async () => {
      // Artifacts packed before the sentinel existed have only the bundle
      // bytes. Explicitly declared as bundle and manifest-valid, they must
      // stay installable (reinstall/rollback from kept bundles).
      const legacyRoot = join(harness.profileRoot, "legacy-artifact");
      await makeWorkspace(join(harness.profileRoot, "legacy-src"));
      const packed = await packArtifact(join(harness.profileRoot, "legacy-src"), legacyRoot);
      await rm(join(packed.outDir, PACKED_ARTIFACT_SENTINEL), { force: true });

      const result = await harness.appManager.install({
        source: { mode: "bundle", path: legacyRoot },
      });
      expect(result.state).toBe("installed");
    });

    it("rejects mode source on a missing or unscaffolded path, naming op create", async () => {
      const missing = join(harness.profileRoot, "never-created");
      await expect(
        harness.appManager.install({
          source: { mode: "source", path: missing },
        }),
      ).rejects.toMatchObject({
        code: "ARTIFACT_INVALID",
        message: expect.stringMatching(/does not exist[\s\S]*"create"/),
      });

      const noManifest = join(harness.profileRoot, "empty-dir");
      await mkdir(noManifest, { recursive: true });
      await expect(
        harness.appManager.install({
          source: { mode: "source", path: noManifest },
        }),
      ).rejects.toMatchObject({
        code: "ARTIFACT_INVALID",
        message: expect.stringMatching(/no app\.yaml[\s\S]*"create"/),
      });
    });

    it("derives the appId from the source manifest, not the directory name", async () => {
      const repo = await makeSourceWorkspace(join(harness.profileRoot, "some-checkout-dir"));
      const result = await harness.appManager.install({
        source: { mode: "source", path: repo },
      });
      expect(result.appId).toBe("testapp");
      expect(result.state).toBe("installed");

      const lockfile = await readLockfile(harness);
      expect(Object.keys(lockfile.apps)).toEqual(["testapp"]);
    });
  });

  // On-disk lockfiles written before the rename spell the packed-artifact
  // mode `"workspace"`. Boot must read them as `"bundle"` instead of marking
  // every installed app broken.
  it("normalizes a legacy mode:workspace lockfile entry to bundle at read", async () => {
    const source: SpecSource = { mode: "bundle", path: packedRoot };
    await harness.appManager.install({ source });

    const raw = await readFile(harness.lockfilePath, "utf-8");
    const parsed = JSON.parse(raw) as { apps: { testapp: { source: { mode: string } } } };
    parsed.apps.testapp.source.mode = "workspace";
    await writeFile(harness.lockfilePath, JSON.stringify(parsed));

    const fresh = await createTestApps({ profileRoot: harness.profileRoot });
    try {
      const boot = await fresh.appManager.boot();
      expect(boot.appCount).toBe(1);
      expect(boot.brokenApps).toEqual([]);
      const entry = await fresh.appManager.readLockfileEntry("testapp");
      expect(entry?.source).toEqual({ mode: "bundle", path: packedRoot });
    } finally {
      await fresh.cleanup();
    }
  });
});
