import { describe, expect, it, rs } from "@rstest/core";
import type { ActionResult, Routine } from "@rome-os/app-runtime";
import { DAILY_DREAM_ROUTINE_NAME, ensureDailyDreamRoutine } from "./daily-routine.js";

function appContext(
  routines: Array<Pick<Routine, "name" | "actionName">>,
  result: ActionResult = { status: "ok" },
) {
  return {
    listRoutines: rs.fn().mockResolvedValue(routines),
    runAction: rs.fn().mockResolvedValue(result),
  };
}

describe("ensureDailyDreamRoutine", () => {
  it("creates a floating daily routine that runs dream", async () => {
    const ctx = appContext([]);

    await expect(ensureDailyDreamRoutine(ctx as never)).resolves.toBe("created");

    expect(ctx.runAction).toHaveBeenCalledWith("create_routine", {
      name: DAILY_DREAM_ROUTINE_NAME,
      trigger: {
        type: "schedule",
        tzid: "UTC",
        tzMode: "floating",
        localTime: "03:00",
        rrule: "FREQ=DAILY",
      },
      actionName: "dream",
      args: {},
    });
  });

  it("leaves an existing daily-dream routine alone", async () => {
    const ctx = appContext([{ name: DAILY_DREAM_ROUTINE_NAME, actionName: "dream" }]);

    await expect(ensureDailyDreamRoutine(ctx as never)).resolves.toBe("exists");

    expect(ctx.runAction).not.toHaveBeenCalled();
  });

  it("is not satisfied by another routine that runs dream", async () => {
    const ctx = appContext([{ name: "weekly-dream", actionName: "dream" }]);

    await expect(ensureDailyDreamRoutine(ctx as never)).resolves.toBe("created");
  });

  it("throws when create_routine rejects the routine", async () => {
    const ctx = appContext([], { status: "error", error: "bad trigger" });

    await expect(ensureDailyDreamRoutine(ctx as never)).rejects.toThrow(
      "create_routine failed: bad trigger",
    );
  });
});
