import { describe, expect, it, rs } from "@rstest/core";
import type { Action, ActionConfig, AppActionRuntimeDeps } from "@rome-os/app-runtime";
import { createAction as listRoutineRuns } from "./list-routine-runs/index.js";
import { createAction as pauseRoutine } from "./pause-routine/index.js";
import { createAction as readRoutineRun } from "./read-routine-run/index.js";
import { createAction as resumeRoutine } from "./resume-routine/index.js";
import type { RoutineControlDeps } from "./routine-control.js";

type Factory = (config: ActionConfig, deps: AppActionRuntimeDeps<RoutineControlDeps>) => Action;

// Each action, the core operation it hands its input to, and an input it takes.
const ACTIONS: Array<[string, Factory, string, Record<string, unknown>]> = [
  ["list_routine_runs", listRoutineRuns, "listRuns", { routineId: "r-1", limit: 3 }],
  ["read_routine_run", readRoutineRun, "readRun", { routineId: "r-1", runId: "x" }],
  ["pause_routine", pauseRoutine, "pause", { routineId: "r-1" }],
  ["resume_routine", resumeRoutine, "resume", { routineId: "r-1" }],
];

const config = (name: string) =>
  ({ name, type: "system", description: "", sideEffects: "write" }) as unknown as ActionConfig;

describe("the routine actions core runs", () => {
  for (const [name, factory, op, input] of ACTIONS) {
    it(`${name} hands its input to core's ${op}`, async () => {
      const call = rs.fn(async () => ({ status: "ok" as const, data: { ok: true } }));

      const result = await factory(config(name), { routineControl: { call } }).execute(input);

      expect(call).toHaveBeenCalledWith(op, input);
      expect(result).toEqual({ status: "ok", data: { ok: true } });
    });

    it(`${name} fails to load without core's routine operations`, () => {
      expect(() => factory(config(name), {} as never)).toThrow(
        `${name} requires a routineControl dep`,
      );
    });
  }
});
