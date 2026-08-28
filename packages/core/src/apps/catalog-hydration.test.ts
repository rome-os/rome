import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { AppCatalog } from "./catalog.js";
import { hydrateCatalogFromLockfile } from "./catalog-hydration.js";
import { AppInstaller } from "./installer.js";
import { readLockfileWithEntryIsolation, type SpecSource } from "./lockfile.js";
import { packArtifact } from "./packaging/index.js";
import { createTestApps, type TestAppsHarness } from "./test-helpers.js";

const SAMPLE_MANIFEST = `formatVersion: 1
id: testapp
version: 0.0.1
description: catalog hydration fixture
agents: []
actions: []
skills: []
hooks: []
`;

async function makeWorkspace(root: string): Promise<string> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "app.yaml"), SAMPLE_MANIFEST, "utf-8");
  return root;
}

async function packWorkspace(workspaceRoot: string): Promise<string> {
  const packedRoot = `${workspaceRoot}.packed`;
  const result = await packArtifact(workspaceRoot, packedRoot);
  return result.outDir;
}

describe("hydrateCatalogFromLockfile", () => {
  let harness: TestAppsHarness;
  let workspaceRoot: string;

  beforeEach(async () => {
    harness = await createTestApps();
    workspaceRoot = await makeWorkspace(join(harness.profileRoot, "fixture-app"));
  });

  afterEach(async () => {
    await rm(`${workspaceRoot}.packed`, { recursive: true, force: true });
    await harness.cleanup();
  });

  it("hydrates a passive catalog without sweeping staging dirs or writing the lockfile", async () => {
    const packedRoot = await packWorkspace(workspaceRoot);
    const source: SpecSource = { mode: "bundle", path: packedRoot };
    await harness.appManager.install({ source });

    const stagingRoot = join(harness.installedRoot, "testapp", ".staging-manual");
    await mkdir(stagingRoot, { recursive: true });
    await writeFile(join(stagingRoot, "marker.txt"), "active prepare owned elsewhere\n", "utf-8");
    const lockfileBefore = await readFile(harness.lockfilePath, "utf-8");
    let markBrokenCalls = 0;

    const installer = new AppInstaller({ installedRoot: harness.installedRoot });
    const catalog = new AppCatalog({
      installer,
      readLockfileEntry: async (appId) => {
        const { lockfile } = await readLockfileWithEntryIsolation(harness.lockfilePath);
        return lockfile.apps[appId] ?? null;
      },
      getInFlight: () => undefined,
      markBroken: async () => {
        markBrokenCalls += 1;
      },
    });

    await hydrateCatalogFromLockfile({ lockfilePath: harness.lockfilePath, catalog });

    expect(catalog.get("testapp")?.state).toBe("installed");
    expect(existsSync(join(stagingRoot, "marker.txt"))).toBe(true);
    expect(markBrokenCalls).toBe(0);
    await expect(readFile(harness.lockfilePath, "utf-8")).resolves.toBe(lockfileBefore);
  });

  it("hydrates past a disabled app whose declared runtime artifact is missing", async () => {
    const actionRoot = join(workspaceRoot, "actions", "echo");
    await mkdir(actionRoot, { recursive: true });
    await writeFile(
      join(workspaceRoot, "app.yaml"),
      `formatVersion: 1
id: testapp
name: Test App
version: 0.0.1
description: catalog hydration fixture
includeSource: true
agents: []
actions:
  - actions/echo
skills: []
hooks: []
`,
      "utf-8",
    );
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await writeFile(join(workspaceRoot, "src", "source.ts"), "export {};\n", "utf-8");
    await writeFile(
      join(actionRoot, "action.yaml"),
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
    const packedRoot = await packWorkspace(workspaceRoot);
    const installed = await harness.appManager.install({
      source: { mode: "bundle", path: packedRoot },
    });
    await harness.appManager.setEnabled("testapp", false);
    await rm(join(harness.installedRoot, "testapp", installed.installedHash!, "actions", "echo"), {
      recursive: true,
      force: true,
    });

    const catalog = new AppCatalog({
      installer: new AppInstaller({ installedRoot: harness.installedRoot }),
      readLockfileEntry: async (appId) => {
        const { lockfile } = await readLockfileWithEntryIsolation(harness.lockfilePath);
        return lockfile.apps[appId] ?? null;
      },
      getInFlight: () => undefined,
      markBroken: async () => {
        throw new Error("disabled hydration must not mark the app broken");
      },
    });

    await expect(
      hydrateCatalogFromLockfile({ lockfilePath: harness.lockfilePath, catalog }),
    ).resolves.toBeUndefined();

    const view = catalog.get("testapp");
    expect(view).toMatchObject({
      appId: "testapp",
      enabled: false,
      displayName: "Test App",
      includeSource: true,
    });
    expect(view && "manifest" in view).toBe(false);
    expect(catalog.listResolved()).toEqual([]);
  });
});
