import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { createTestDb, type TestDb } from "../../test/helpers.js";

describe("RoutineRunsRepository", () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(() => {
    testDb.close();
  });

  // Usage attribution looks up a run by its root execution for every routine
  // turn and action run it reports.
  it("finds a run by execution id through an index", () => {
    const sqlite = (
      testDb.db as unknown as {
        $client: {
          prepare(sql: string): { all(...values: unknown[]): Array<{ detail: string }> };
        };
      }
    ).$client;
    const plan = sqlite
      .prepare(
        "EXPLAIN QUERY PLAN SELECT fired_by FROM routine_runs WHERE execution_id = ? LIMIT 1",
      )
      .all("root");
    expect(plan.map((row) => row.detail).join("\n")).toContain("idx_routine_runs_execution_id");
  });
});
