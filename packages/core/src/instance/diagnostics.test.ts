import { afterEach, describe, expect, it } from "@rstest/core";
import { assembleDiagnosticBundle } from "./diagnostics.js";
import { buildTestDeps, createTestDb, type TestDb } from "../test/helpers.js";

describe("assembleDiagnosticBundle", () => {
  let testDb: TestDb;

  afterEach(() => {
    testDb?.close();
  });

  it("given a healthy instance, when assembled, then it reports build, uptime, db ok and app counts", async () => {
    testDb = createTestDb();
    const deps = await buildTestDeps(testDb.db);

    const bundle = await assembleDiagnosticBundle(deps);

    expect(bundle.database.ok).toBe(true);
    expect(bundle.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(bundle).toHaveProperty("build");
    expect(bundle).toHaveProperty("channels");
    expect(bundle.apps).toEqual({ total: expect.any(Number), failed: [], broken: [] });
  });

  it("given a broken DB, when assembled, then it degrades to database.ok=false instead of throwing", async () => {
    testDb = createTestDb();
    const deps = await buildTestDeps(testDb.db);
    deps.settingsRepo.get = async () => {
      throw new Error("db gone");
    };

    const bundle = await assembleDiagnosticBundle(deps);

    expect(bundle.database.ok).toBe(false);
  });

  it("given no Rome Cloud-bound identity, when assembled, then the bundle carries no instance field (identity is the probe's concern)", async () => {
    testDb = createTestDb();
    const deps = await buildTestDeps(testDb.db);

    const bundle = await assembleDiagnosticBundle(deps);

    expect(bundle).not.toHaveProperty("instance");
  });
});
