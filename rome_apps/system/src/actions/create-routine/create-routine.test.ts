import { describe, expect, it, rs } from "@rstest/core";
import type { ActionConfig } from "@rome-os/app-runtime";
import { createAction } from "./index.js";

// The rules for a new routine are core's (packages/core/src/routines/create.ts,
// tested there). This action only hands its input over.

const config: ActionConfig = {
  name: "create_routine",
  type: "system",
  description: "Create a routine",
  complexity: "simple",
  speed: "fast",
  reliability: "high",
  sideEffects: "write",
};

const input = {
  name: "daily-dream",
  trigger: { type: "manual" },
  actionName: "dream",
  args: {},
};

describe("create_routine", () => {
  it("hands its input to core's routine creation and returns what core answers", async () => {
    const create = rs.fn(async () => ({ status: "ok" as const, data: { routineId: "r-1" } }));
    const action = createAction(config, { routineCreation: { create } } as never);

    const result = await action.execute(input);

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: "daily-dream" }));
    expect(result).toEqual({ status: "ok", data: { routineId: "r-1" } });
  });

  it("passes on only the status and text of an error", async () => {
    const create = rs.fn(async () => ({
      status: "error" as const,
      error: 'a routine with key "k" already exists (id r-1)',
      existingId: "r-1",
    }));
    const action = createAction(config, { routineCreation: { create } } as never);

    expect(await action.execute({ ...input, key: "k" })).toEqual({
      status: "error",
      error: 'a routine with key "k" already exists (id r-1)',
    });
  });

  it("refuses to load without core's routine creation", () => {
    expect(() => createAction(config, {} as never)).toThrow(/routineCreation/);
  });
});
