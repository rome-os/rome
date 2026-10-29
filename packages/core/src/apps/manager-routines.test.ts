import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { createAppDomain, type AppDomain } from "./index.js";
import { createEmptyLegacyArtifactBindings, formatArtifactId } from "./artifact-id.js";
import { packArtifact } from "./packaging/index.js";
import { isResolvedApp } from "./state.js";
import { ActionRegistryImpl } from "../actions/registry.js";
import type { ActionEngine } from "../actions/engine.js";
import { RoutinesRepository } from "../db/repositories/routines.js";
import { RoutineRunsRepository } from "../db/repositories/routine-runs.js";
import { RoutineEngine } from "../routines/engine.js";
import { systemClock } from "../lib/clock.js";
import { createTestDb, type TestDb } from "../test/helpers.js";

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
    const legacyBindings = createEmptyLegacyArtifactBindings();
    legacyBindings.action.legacy = formatArtifactId("app-a", "run");
    legacyBindings.action.run = formatArtifactId("app-b", "run");
    registry = new ActionRegistryImpl({ legacyBindings });
    domain = createAppDomain({
      lockfilePath: join(root, "apps.lock.json"),
      installedRoot: join(root, "installed"),
      routines: { actionRegistry: registry, repository, engine },
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
    const legacy = await seed("legacy", true, "app-b");
    const paused = await seed("app-a:run", false);
    const unrelated = await seed("app-b:run");
    const shared = await seed("run", true, "app-a");
    const missing = await seed("missing");
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
      expect((await repository.findById(id))?.enabled).toBe(false);
      await originalDeactivate(id);
    });
    expect(active.has(qualified)).toBe(true);
    expect(active.has(legacy)).toBe(true);

    if (operation === "disable") await domain.manager.setEnabled("app-a", false);
    else await domain.manager.uninstall("app-a");

    expect(registry.has("app-a:run")).toBe(false);
    expect(update.mock.calls).toEqual([
      [qualified, { enabled: false }],
      [legacy, { enabled: false }],
    ]);
    expect(deactivate.mock.calls).toEqual([[qualified], [legacy]]);
    for (const id of [qualified, legacy]) {
      expect((await repository.findById(id))?.enabled).toBe(false);
      expect(active.has(id)).toBe(false);
    }
    for (const id of [unrelated, shared, missing]) {
      expect((await repository.findById(id))?.enabled).toBe(true);
      expect(active.has(id)).toBe(true);
    }
    expect(await repository.findById(paused)).toEqual(pausedBefore);
    expect(active.has(paused)).toBe(false);
    expect(await runs.findById(historyId)).toEqual(history);
    expect(await repository.findAll()).toHaveLength(6);

    if (operation === "disable") {
      await domain.manager.setEnabled("app-a", true);
      expect((await repository.findById(qualified))?.enabled).toBe(false);
      expect((await repository.findById(legacy))?.enabled).toBe(false);
      expect(active.has(qualified)).toBe(false);
      expect(update).toHaveBeenCalledTimes(2);
    }
  });
});
