import { describe, expect, it, rs } from "@rstest/core";
import type { ActionResult, Routine } from "@rome-os/app-runtime";
import {
  DREAM_ROUTINE_NAME,
  LEGACY_DREAM_ROUTINE_NAME,
  ensureDreamRoutine,
  findDreamRoutine,
} from "./dream-routine.js";

type RoutineStub = Pick<Routine, "id" | "name" | "actionName" | "enabled">;

function routine(name: string, enabled = true): RoutineStub {
  return { id: `${name}-id`, name, actionName: "dream", enabled };
}

function appContext(routines: RoutineStub[], results: Partial<Record<string, ActionResult>> = {}) {
  return {
    listRoutines: rs.fn().mockResolvedValue(routines),
    runAction: rs.fn(async (name: string) => results[name] ?? { status: "ok" }),
  };
}

describe("ensureDreamRoutine", () => {
  it("creates a floating routine that dreams over three days every three days", async () => {
    const ctx = appContext([]);

    await expect(ensureDreamRoutine(ctx as never)).resolves.toBe("created");

    expect(ctx.runAction).toHaveBeenCalledTimes(1);
    expect(ctx.runAction).toHaveBeenCalledWith("create_routine", {
      name: DREAM_ROUTINE_NAME,
      trigger: {
        type: "schedule",
        tzid: "UTC",
        tzMode: "floating",
        localTime: "03:00",
        rrule: "FREQ=DAILY;INTERVAL=3",
      },
      actionName: "dream",
      args: { windowHours: 74 },
    });
  });

  it("leaves an existing dream routine alone, enabled or not", async () => {
    const ctx = appContext([routine(DREAM_ROUTINE_NAME, false)]);

    await expect(ensureDreamRoutine(ctx as never)).resolves.toBe("exists");

    expect(ctx.runAction).not.toHaveBeenCalled();
  });

  it("is not satisfied by another routine that runs dream", async () => {
    const ctx = appContext([routine("weekly-dream")]);

    await expect(ensureDreamRoutine(ctx as never)).resolves.toBe("created");
  });

  it("replaces an enabled daily routine, creating the new one first", async () => {
    const ctx = appContext([routine(LEGACY_DREAM_ROUTINE_NAME)]);

    await expect(ensureDreamRoutine(ctx as never)).resolves.toBe("replaced");

    expect(ctx.runAction.mock.calls.map(([name]) => name)).toEqual([
      "create_routine",
      "delete_routine",
    ]);
    expect(ctx.runAction).toHaveBeenLastCalledWith("delete_routine", {
      routineId: `${LEGACY_DREAM_ROUTINE_NAME}-id`,
    });
  });

  it("keeps a daily routine the guardian turned off, and adds none", async () => {
    const ctx = appContext([routine(LEGACY_DREAM_ROUTINE_NAME, false)]);

    await expect(ensureDreamRoutine(ctx as never)).resolves.toBe("exists");

    expect(ctx.runAction).not.toHaveBeenCalled();
  });

  it("deletes a daily routine a previous start failed to delete", async () => {
    const ctx = appContext([routine(DREAM_ROUTINE_NAME), routine(LEGACY_DREAM_ROUTINE_NAME)]);

    await expect(ensureDreamRoutine(ctx as never)).resolves.toBe("replaced");

    expect(ctx.runAction).toHaveBeenCalledTimes(1);
    expect(ctx.runAction).toHaveBeenCalledWith("delete_routine", {
      routineId: `${LEGACY_DREAM_ROUTINE_NAME}-id`,
    });
  });

  it("throws when the daily routine cannot be deleted yet", async () => {
    const ctx = appContext([routine(LEGACY_DREAM_ROUTINE_NAME)], {
      delete_routine: { status: "error", error: "has 1 active run(s)" },
    });

    await expect(ensureDreamRoutine(ctx as never)).rejects.toThrow("has 1 active run(s)");
    expect(ctx.runAction).toHaveBeenCalledWith("create_routine", expect.anything());
  });

  it("throws when create_routine rejects the routine", async () => {
    const ctx = appContext([], { create_routine: { status: "error", error: "bad trigger" } });

    await expect(ensureDreamRoutine(ctx as never)).rejects.toThrow(
      "create_routine failed: bad trigger",
    );
  });
});

describe("findDreamRoutine", () => {
  it("prefers the dream routine and falls back to the daily one", () => {
    const current = routine(DREAM_ROUTINE_NAME);
    const legacy = routine(LEGACY_DREAM_ROUTINE_NAME, false);

    expect(findDreamRoutine([legacy, current] as Routine[])).toBe(current);
    expect(findDreamRoutine([legacy] as Routine[])).toBe(legacy);
    expect(findDreamRoutine([routine("other")] as Routine[])).toBeUndefined();
  });
});
