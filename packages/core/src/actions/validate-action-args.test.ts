import { describe, expect, it } from "@rstest/core";
import { z } from "zod";
import { validateActionArgs } from "./validate-action-args.js";

/** The input schema `defineAction` emits for a zod schema. */
function emittedSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _schema, ...inputSchema } = z.toJSONSchema(schema) as Record<string, unknown>;
  return inputSchema;
}

describe("validateActionArgs", () => {
  it("accepts args that omit a field with a zod default, without filling it in", () => {
    // z.toJSONSchema lists a defaulted field under `required`, while the
    // action's own zod parse fills it in.
    const schema = emittedSchema(
      z.object({ script: z.string(), timeoutSeconds: z.number().int().default(60) }),
    );
    const args = { script: "ls" };

    expect(validateActionArgs("execute_root_script", args, schema)).toBeNull();
    expect(args).toEqual({ script: "ls" });
  });

  it("rejects args missing a required field that has no default", () => {
    const schema = emittedSchema(
      z.object({ script: z.string(), timeoutSeconds: z.number().int().default(60) }),
    );

    expect(validateActionArgs("execute_root_script", {}, schema)).toMatch(
      /args do not satisfy the input schema for action "execute_root_script": .*script/,
    );
  });

  it("rejects an unknown key when the schema forbids extra properties", () => {
    const schema = emittedSchema(z.object({ agentName: z.string() }));

    expect(validateActionArgs("summon", { agentName: "main", extra: 1 }, schema)).toMatch(
      /additional properties/,
    );
  });

  it("accepts any args when the action declares no schema", () => {
    expect(validateActionArgs("legacy", { anything: true }, undefined)).toBeNull();
  });
});
