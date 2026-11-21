import { describe, expect, it } from "@rstest/core";
import { z } from "zod";
import { createRoutineInputSchema as actionSchema } from "../../../../rome_apps/system/src/actions/create-routine/index.js";
import { createRoutineInputSchema as coreSchema } from "./create.js";

// The system action validates its input before core does, so the two schemas
// must accept the same routines and describe them in the same words.
describe("create_routine's input schema", () => {
  it("is the same in the system action as in core", () => {
    expect(z.toJSONSchema(actionSchema)).toEqual(z.toJSONSchema(coreSchema));
  });
});
