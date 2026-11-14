import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { ActionEngine } from "../apps/actions/engine.js";
import { ActionRegistryImpl } from "../apps/actions/registry.js";
import { createActionEngineRepos, createTestDb, type TestDb } from "../test/db.js";
import { registerPersonalDataActions } from "./actions.js";
import { PersonalDataRepository } from "./repository.js";
import { APPLE_HEALTH } from "./sources/apple-health.js";
import { PERSONAL_DATA_SOURCES } from "./sources/index.js";
import { batch, DAY, HOUR, NOV_10, stepDay, TZ } from "./__fixtures__/apple-health.js";

describe("personal-data actions", () => {
  let testDb: TestDb;
  let engine: ActionEngine;

  beforeEach(() => {
    testDb = createTestDb();
    const repo = new PersonalDataRepository(testDb.db, PERSONAL_DATA_SOURCES);
    repo.ingest(
      APPLE_HEALTH,
      batch("seed", { upserts: [stepDay(NOV_10, 8000), stepDay(NOV_10 + DAY, 6000)] }),
      NOV_10 + 2 * DAY,
    );
    const registry = new ActionRegistryImpl();
    registerPersonalDataActions(registry, {
      personalData: repo,
      guardianTimeZone: async () => TZ,
      now: () => NOV_10 + 2 * DAY + 9 * HOUR,
    });
    engine = new ActionEngine(registry, createActionEngineRepos(), {
      processRole: "main",
      isFirstPartyAction: () => true,
    });
  });
  afterEach(() => testDb.close());

  it("lists the catalog in a private turn", async () => {
    const result = await engine.run("core:personal_data_catalog", {}, { audience: "private" });
    expect(result).toMatchObject({
      status: "ok",
      data: { sources: [{ source: "apple_health", origin: { name: "iPhone" } }] },
    });
  });

  it("answers a query in a private turn, in the guardian's zone by default", async () => {
    const result = await engine.run(
      "core:personal_data_query",
      { source: "apple_health", type: "stepCount", start: "2026-11-10", end: "2026-11-11" },
      { audience: "private" },
    );
    expect(result).toMatchObject({
      status: "ok",
      data: { timeZoneIdentifier: TZ, results: [{ type: "stepCount", value: 14000 }] },
    });
  });

  it("returns a query it cannot answer as an error the Agent reads", async () => {
    const result = await engine.run(
      "core:personal_data_query",
      { source: "apple_health", type: "mood" },
      { audience: "private" },
    );
    expect(result).toMatchObject({ status: "error" });
  });

  it.each([
    { audience: "shared" as const },
    {},
  ])("refuses both actions outside a private turn (%o), before they run", async (context) => {
    for (const name of ["core:personal_data_catalog", "core:personal_data_query"]) {
      const result = await engine.run(name, { source: "apple_health", type: "stepCount" }, context);
      expect(result).toEqual({
        status: "error",
        error: expect.stringMatching(/^personal_data_private_only: /),
      });
    }
  });
});
