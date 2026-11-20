import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { createAppDomain, type AppDomain } from "../apps/index.js";
import { packArtifact } from "../apps/packaging/index.js";
import { installFirstPartyAppsAtBoot } from "../apps/boot-upgrade.js";
import { isResolvedApp } from "../apps/state.js";
import { ActionRegistryImpl } from "../apps/actions/registry.js";
import type { ActionEngine } from "../apps/actions/engine.js";
import { RoutinesRepository } from "../db/repositories/routines.js";
import { RoutineRunsRepository } from "../db/repositories/routine-runs.js";
import { RoutineEngine } from "./engine.js";
import { appRoutinePauser, deleteRoutinesOfRemovedApps } from "./app-routine-pauser.js";
import { systemClock } from "../lib/clock.js";
import { createTestDb, type TestDb } from "../test/db.js";

describe("AppManager routine lifecycle", () => {
  let root: string;
  let testDb: TestDb;
  let domain: AppDomain;
  let repository: RoutinesRepository;
  let runs: RoutineRunsRepository;
  let engine: RoutineEngine;
  let registry: ActionRegistryImpl;
  let active: Set<string>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "rome-manager-routines-"));
    testDb = createTestDb();
    repository = new RoutinesRepository(testDb.db);
    runs = new RoutineRunsRepository(testDb.db);
    engine = new RoutineEngine(repository, runs, {} as ActionEngine, 0, systemClock);
    active = new Set();
    engine.registerProvider("manual", {
      type: "manual",
      activate: async (routine) => {
        active.add(routine.id);
      },
      deactivate: (id) => {
        active.delete(id);
      },
      stop: () => {
        active.clear();
      },
    });
    registry = new ActionRegistryImpl({
      legacyBindings: { version: 1, agent: {}, action: {}, skill: {} },
    });
    domain = createAppDomain({
      lockfilePath: join(root, "apps.lock.json"),
      installedRoot: join(root, "installed"),
      pauseRoutines: appRoutinePauser({ repository, engine }),
      deleteRoutines: async (appId) => {
        const { deleted } = await repository.deleteManagedRoutines([appId]);
        for (const id of deleted) await engine.deactivate(id);
      },
    });
    domain.catalog.subscribe((event) => {
      if (!isResolvedApp(event.current)) registry.unregisterOwnedBy("app", event.appId);
    });
    for (const appId of ["app-a", "app-b"]) {
      const source = join(root, appId);
      await mkdir(source);
      await writeFile(
        join(source, "app.yaml"),
        `formatVersion: 1\nid: ${appId}\nversion: 0.0.1\ndescription: test\n`,
      );
      const packed = await packArtifact(source, `${source}.packed`);
      await domain.manager.install({ source: { mode: "bundle", path: packed.outDir } });
      registry.register(
        {
          config: {
            name: "run",
            type: "system",
            description: "test",
            complexity: "simple",
            speed: "fast",
            reliability: "high",
            sideEffects: "read-only",
          },
          execute: async () => ({ status: "ok" }),
        },
        {
          kind: "action",
          ownerType: "app",
          ownerId: appId,
          publicName: "run",
          aliases: [],
          sourcePath: source,
        },
      );
    }
  });

  afterEach(async () => {
    engine?.stop();
    testDb?.close();
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    "disable",
    "uninstall",
  ] as const)("%s pauses only enabled routines targeting the app, keeping history", async (operation) => {
    // `shared` is managed by app-a but fires another app's action: disable
    // leaves it running, uninstall deletes it.
    const seed = (actionName: string, enabled = true, managedBy?: string) =>
      repository.create({
        name: actionName,
        actionName,
        enabled,
        managedBy,
        trigger: { type: "manual" },
        args: {},
      });
    const qualified = await seed("app-a:run");
    const paused = await seed("app-a:run", false);
    const unrelated = await seed("app-b:run");
    const shared = await seed("run", true, "app-a");
    const missing = await seed("missing");
    const lookalike = await seed("app-a-x:run");
    const historyId = await runs.create({
      routineId: qualified,
      executionId: "test-run",
      status: "success",
    });
    const history = await runs.findById(historyId);
    const pausedBefore = await repository.findById(paused);
    await engine.start();
    const update = rs.spyOn(repository, "update");
    const originalDeactivate = engine.deactivate.bind(engine);
    const deactivate = rs.spyOn(engine, "deactivate").mockImplementation(async (id) => {
      const row = await repository.findById(id);
      if (row) expect(row.enabled).toBe(false);
      await originalDeactivate(id);
    });
    expect(active.has(qualified)).toBe(true);

    if (operation === "disable") await domain.manager.setEnabled("app-a", false);
    else await domain.manager.uninstall("app-a");

    expect(registry.has("app-a:run")).toBe(false);
    expect(update.mock.calls).toEqual([[qualified, { enabled: false }]]);
    expect(deactivate.mock.calls).toEqual(
      operation === "disable" ? [[qualified]] : [[qualified], [shared]],
    );
    expect((await repository.findById(qualified))?.enabled).toBe(false);
    expect(active.has(qualified)).toBe(false);
    if (operation === "uninstall") {
      expect(await repository.findById(shared)).toBeNull();
      expect(active.has(shared)).toBe(false);
    }
    const untouched =
      operation === "disable"
        ? [unrelated, shared, missing, lookalike]
        : [unrelated, missing, lookalike];
    for (const id of untouched) {
      expect((await repository.findById(id))?.enabled).toBe(true);
      expect(active.has(id)).toBe(true);
    }
    expect(await repository.findById(paused)).toEqual(pausedBefore);
    expect(active.has(paused)).toBe(false);
    expect(await runs.findById(historyId)).toEqual(history);
    expect(await repository.findAll()).toHaveLength(operation === "disable" ? 6 : 5);

    if (operation === "disable") {
      await domain.manager.setEnabled("app-a", true);
      expect((await repository.findById(qualified))?.enabled).toBe(false);
      expect(active.has(qualified)).toBe(false);
      expect(update).toHaveBeenCalledTimes(1);
    }
  });

  it("uninstall deletes the app's managed routines with their history, and disable does not", async () => {
    const seed = (name: string, actionName: string, managedBy: string) =>
      repository.create({
        name,
        actionName,
        managedBy,
        trigger: { type: "manual" },
        args: {},
      });
    const own = await seed("own", "app-a:run", "app-a");
    const other = await seed("other", "app-b:run", "app-b");
    const historyId = await runs.create({
      routineId: own,
      executionId: "test-delete-run",
      status: "success",
    });

    await domain.manager.setEnabled("app-a", false);
    expect((await repository.findById(own))?.managedBy).toBe("app-a");

    await domain.manager.uninstall("app-a");
    expect(await repository.findById(own)).toBeNull();
    expect(await runs.findById(historyId)).toBeNull();
    expect((await repository.findById(other))?.managedBy).toBe("app-b");
  });

  it("deletes routines only of the apps it is given, keeping one with an active run", async () => {
    const seed = (name: string, managedBy?: string) =>
      repository.create({
        name,
        actionName: "app-b:run",
        managedBy,
        trigger: { type: "manual" },
        args: {},
      });
    const gone = await seed("gone", "removed-app");
    const running = await seed("running", "removed-app");
    const kept = await seed("kept", "app-b");
    const plain = await seed("plain");
    await runs.create({ routineId: running, executionId: "test-active-run", status: "running" });

    expect((await repository.managingAppIds()).sort()).toEqual(["app-b", "removed-app"]);
    expect(await repository.deleteManagedRoutines([])).toEqual({ deleted: [], kept: 0 });
    expect(await repository.deleteManagedRoutines(["removed-app"])).toEqual({
      deleted: [gone],
      kept: 1,
    });
    expect(await repository.findById(gone)).toBeNull();
    expect((await repository.findById(running))?.managedBy).toBe("removed-app");
    expect((await repository.findById(kept))?.managedBy).toBe("app-b");
    expect(await repository.findById(plain)).toBeTruthy();
  });

  it("boot deletes only routines of apps missing from the lockfile, not ones the catalog missed", async () => {
    const seed = (name: string, managedBy: string) =>
      repository.create({
        name,
        actionName: "app-b:run",
        managedBy,
        trigger: { type: "manual" },
        args: {},
      });
    const removed = await seed("removed", "removed-app");
    const installed = await seed("installed", "app-a");
    // A fresh domain whose boot never ran has an empty catalog, as after a
    // failed app boot. app-a is still in the lockfile.
    const unbooted = createAppDomain({
      lockfilePath: join(root, "apps.lock.json"),
      installedRoot: join(root, "installed"),
    });
    expect(unbooted.catalog.list()).toEqual([]);

    const result = await deleteRoutinesOfRemovedApps({
      repository,
      readLockfileEntry: (appId) => unbooted.manager.readLockfileEntry(appId),
    });

    expect(result).toEqual({ apps: ["removed-app"], deleted: 1, kept: 0 });
    expect(await repository.findById(removed)).toBeNull();
    expect((await repository.findById(installed))?.managedBy).toBe("app-a");
  });

  it.each([
    "uninstall",
    "boot removal pass",
  ] as const)("%s pauses the app's routines before actions register or the engine is available", async (operation) => {
    registry.unregisterOwnedBy("app");
    let deactivateRoutine: ((id: string) => Promise<void>) | undefined;
    const bootDomain = createAppDomain({
      lockfilePath: join(root, "apps.lock.json"),
      installedRoot: join(root, "installed"),
      pauseRoutines: appRoutinePauser({
        repository,
        engine: {
          deactivate: async (id) => {
            await deactivateRoutine?.(id);
          },
        },
      }),
    });
    await bootDomain.manager.boot();
    await bootDomain.manager.install({
      source: { mode: "bundle", path: join(root, "app-a.packed") },
      firstParty: true,
    });
    const seed = (actionName: string, enabled = true) =>
      repository.create({
        name: actionName,
        actionName,
        enabled,
        trigger: { type: "manual" },
        args: {},
      });
    const qualified = await seed("app-a:run");
    const unrelated = await seed("app-b:run");
    const lookalike = await seed("app-a-x:run");
    const paused = await seed("app-a:run", false);
    const shared = await seed("run");
    const missing = await seed("missing");
    const pausedBefore = await repository.findById(paused);
    const historyId = await runs.create({
      routineId: qualified,
      executionId: "test-boot-run",
      status: "success",
    });
    const history = await runs.findById(historyId);
    const update = rs.spyOn(repository, "update");
    const deactivate = rs.spyOn(engine, "deactivate");
    const uninstall = rs.spyOn(bootDomain.manager, "uninstall");
    expect(registry.list()).toEqual([]);

    if (operation === "uninstall") {
      await bootDomain.manager.uninstall("app-a", { firstParty: true });
    } else {
      await packArtifact(join(root, "app-b"), join(root, "dist", "first-party-artifacts", "app-b"));
      const result = await installFirstPartyAppsAtBoot({
        appManager: bootDomain.manager,
        appCatalog: bootDomain.catalog,
        projectRoot: root,
      });
      expect(result.removed).toEqual(["app-a"]);
    }

    expect(uninstall).toHaveBeenCalledWith("app-a", { firstParty: true });
    expect(await bootDomain.manager.readLockfileEntry("app-a")).toBeNull();
    expect((await repository.findById(qualified))?.enabled).toBe(false);
    expect(update.mock.calls).toEqual([[qualified, { enabled: false }]]);
    expect(deactivate).not.toHaveBeenCalled();
    expect(await repository.findById(paused)).toEqual(pausedBefore);
    expect(await runs.findById(historyId)).toEqual(history);
    expect(await repository.findAll()).toHaveLength(6);
    for (const id of [unrelated, lookalike, shared, missing]) {
      expect((await repository.findById(id))?.enabled).toBe(true);
    }

    deactivateRoutine = (id) => engine.deactivate(id);
    await engine.start();
    expect(active.has(qualified)).toBe(false);
    expect(active.has(paused)).toBe(false);
    for (const id of [unrelated, lookalike, shared, missing]) {
      expect(active.has(id)).toBe(true);
    }
    await bootDomain.manager.setEnabled("app-b", false);
    // A routine names its action by full ID, so `run` belongs to no app.
    expect(deactivate.mock.calls).toEqual([[unrelated]]);
    expect(active.has(unrelated)).toBe(false);
    expect(active.has(shared)).toBe(true);
  });

  it.each([
    "installed",
    "failed",
  ] as const)("%s reinstall disables the app and pauses its routines", async (state) => {
    const seed = (actionName: string, enabled = true) =>
      repository.create({
        name: actionName,
        actionName,
        enabled,
        trigger: { type: "manual" },
        args: {},
      });
    const qualified = await seed("app-a:run");
    const paused = await seed("app-a:run", false);
    const unrelated = await seed("app-b:run");
    const lookalike = await seed("app-a-x:run");
    const pausedBefore = await repository.findById(paused);
    const historyId = await runs.create({
      routineId: qualified,
      executionId: "test-reinstall-run",
      status: "success",
    });
    const history = await runs.findById(historyId);
    await engine.start();
    const update = rs.spyOn(repository, "update");
    const deactivate = rs.spyOn(engine, "deactivate");
    if (state === "failed") {
      rs.spyOn(domain.installer, "materialize").mockRejectedValueOnce(
        new Error("test materialization failure"),
      );
    }

    const result = await domain.manager.install({
      source: { mode: "bundle", path: join(root, "app-a.packed") },
      enabled: false,
    });

    expect(result.appId).toBe("app-a");
    expect(result.state).toBe(state);
    expect((await domain.manager.readLockfileEntry("app-a"))?.enabled).toBe(false);
    expect(registry.has("app-a:run")).toBe(false);
    expect(update.mock.calls).toEqual([[qualified, { enabled: false }]]);
    expect(deactivate.mock.calls).toEqual([[qualified]]);
    expect((await repository.findById(qualified))?.enabled).toBe(false);
    expect(active.has(qualified)).toBe(false);
    for (const id of [unrelated, lookalike]) {
      expect((await repository.findById(id))?.enabled).toBe(true);
      expect(active.has(id)).toBe(true);
    }
    expect(await repository.findById(paused)).toEqual(pausedBefore);
    expect(active.has(paused)).toBe(false);
    expect(await runs.findById(historyId)).toEqual(history);
    expect(await repository.findAll()).toHaveLength(4);
  });

  it.each([undefined, true])("reinstall with enabled=%s pauses no routines", async (enabled) => {
    const ids = [];
    for (const actionName of ["app-a:run"]) {
      ids.push(
        await repository.create({
          name: actionName,
          actionName,
          trigger: { type: "manual" },
          args: {},
        }),
      );
    }
    await engine.start();
    const update = rs.spyOn(repository, "update");
    const deactivate = rs.spyOn(engine, "deactivate");

    const result = await domain.manager.install({
      source: { mode: "bundle", path: join(root, "app-a.packed") },
      ...(enabled === undefined ? {} : { enabled }),
    });

    expect(result.state).toBe("installed");
    expect((await domain.manager.readLockfileEntry("app-a"))?.enabled).toBe(true);
    expect(update).not.toHaveBeenCalled();
    expect(deactivate).not.toHaveBeenCalled();
    for (const id of ids) {
      expect((await repository.findById(id))?.enabled).toBe(true);
      expect(active.has(id)).toBe(true);
    }
  });

  it.each([
    "fresh",
    "already-disabled",
  ] as const)("%s disabled install pauses no routines", async (prior) => {
    if (prior === "fresh") await domain.manager.uninstall("app-a");
    else await domain.manager.setEnabled("app-a", false);
    const id = await repository.create({
      name: "app-a:run",
      actionName: "app-a:run",
      trigger: { type: "manual" },
      args: {},
    });
    const before = await repository.findById(id);
    await engine.start();
    const update = rs.spyOn(repository, "update");
    const deactivate = rs.spyOn(engine, "deactivate");

    const result = await domain.manager.install({
      source: { mode: "bundle", path: join(root, "app-a.packed") },
      enabled: false,
    });

    expect(result.state).toBe("installed");
    expect((await domain.manager.readLockfileEntry("app-a"))?.enabled).toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect(deactivate).not.toHaveBeenCalled();
    expect(await repository.findById(id)).toEqual(before);
    expect(active.has(id)).toBe(true);
  });
});
