import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import { RoutineRunsRepository } from "./routine-runs.js";
import { RoutinesRepository } from "./routines.js";

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

  // Runs recorded before `fired_by` existed still name their routine.
  it("falls back to the run's own routine trigger when the run predates fired_by", async () => {
    const routines = new RoutinesRepository(testDb.db);
    const runs = new RoutineRunsRepository(testDb.db);
    const onEmail = await routines.create({
      name: "Digest",
      trigger: { type: "event-bus", eventName: "message:received" },
      actionName: "noop",
      args: {},
    });
    await routines.create({
      name: "Digest",
      trigger: { type: "schedule", tzid: "UTC", tzMode: "fixed", localTime: "09:00" },
      actionName: "noop",
      args: {},
    });
    await runs.create({ routineId: onEmail, executionId: "legacy-root", status: "success" });
    expect(await runs.findFiredBy("legacy-root")).toBe("event-bus");
  });
});

describe("RoutinesRepository.findTriggerTypeByName", () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(() => {
    testDb.close();
  });

  it("answers only when every routine with the name shares a trigger type", async () => {
    const routines = new RoutinesRepository(testDb.db);
    const schedule = {
      type: "schedule",
      tzid: "UTC",
      tzMode: "fixed",
      localTime: "09:00",
    } as const;
    await routines.create({ name: "Daily", trigger: schedule, actionName: "a", args: {} });
    await routines.create({ name: "Daily", trigger: schedule, actionName: "b", args: {} });
    await routines.create({ name: "Digest", trigger: schedule, actionName: "a", args: {} });
    await routines.create({
      name: "Digest",
      trigger: { type: "event-bus", eventName: "message:received" },
      actionName: "b",
      args: {},
    });
    expect(await routines.findTriggerTypeByName("Daily")).toBe("schedule");
    expect(await routines.findTriggerTypeByName("Digest")).toBeNull();
    expect(await routines.findTriggerTypeByName("Missing")).toBeNull();
  });
});
