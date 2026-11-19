import { describe, expect, it, rs } from "@rstest/core";
import type { ActionConfig } from "@rome-os/app-runtime";
import { createAction as listRoutineRuns } from "./list-routine-runs/index.js";
import { createAction as readRoutineRun } from "./read-routine-run/index.js";

const config = (name: string) =>
  ({ name, type: "system", description: "", sideEffects: "read-only" }) as unknown as ActionConfig;

describe("the routine actions core runs", () => {
  it("hands each action's input to its core operation", async () => {
    const call = rs.fn(async () => ({ status: "ok" as const, data: { ok: true } }));
    const deps = { routineControl: { call } };

    await listRoutineRuns(config("list_routine_runs"), deps).execute({
      routineId: "r-1",
      limit: 3,
    });
    await readRoutineRun(config("read_routine_run"), deps).execute({
      routineId: "r-1",
      runId: "x",
    });

    expect(call.mock.calls).toEqual([
      ["listRuns", { routineId: "r-1", limit: 3 }],
      ["readRun", { routineId: "r-1", runId: "x" }],
    ]);
  });

  it("fails to load without core's routine operations", () => {
    expect(() => listRoutineRuns(config("list_routine_runs"), {} as never)).toThrow(
      "list_routine_runs requires a routineControl dep",
    );
  });
});
