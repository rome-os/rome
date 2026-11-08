import { describe, expect, it } from "@rstest/core";
import { z } from "zod";
import { toMcpToolShape } from "./json-schema-zod.js";

describe("toMcpToolShape", () => {
  it("preserves nested array<object> item shape", () => {
    const shape = toMcpToolShape("nested_questions_tool", {
      type: "object",
      properties: {
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              text: { type: "string" },
            },
            required: ["id", "text"],
          },
        },
      },
      required: ["questions"],
    });

    const obj = z.object(shape);
    expect(obj.safeParse({ questions: [{ id: "q1", text: "Pick" }] }).success).toBe(true);
    // String-in-array — the malformed shape Codex used to produce — is rejected.
    expect(obj.safeParse({ questions: ["q1 Pick"] }).success).toBe(false);
    // And the round trip to JSON Schema succeeds (the SDK does this when
    // serving tools/list).
    expect(() => z.toJSONSchema(obj)).not.toThrow();
  });

  it("falls back to a flat shape when the schema contains allOf/if/then", () => {
    // Conditional schemas (like app_management's) produce zod constructs the
    // SDK cannot serialize. The fallback drops the conditional but keeps
    // tools/list working.
    const shape = toMcpToolShape("conditional_tool", {
      type: "object",
      properties: {
        op: { type: "string", enum: ["apply", "uninstall"] },
        appId: { type: "string" },
        source: { type: "string" },
      },
      required: ["op"],
      allOf: [
        {
          if: { properties: { op: { const: "apply" } }, required: ["op"] },
          then: { required: ["appId", "source"] },
        },
      ],
    });

    const obj = z.object(shape);
    // Flat fallback drops the conditional, so this passes — that's the
    // documented trade-off, not a regression (matches the pre-runtime-
    // converter behavior).
    expect(obj.safeParse({ op: "apply" }).success).toBe(true);
    // Tools/list serialization must still work.
    expect(() => z.toJSONSchema(obj)).not.toThrow();
  });

  it("returns an empty shape for parameterless tools", () => {
    const shape = toMcpToolShape("list_actions", {
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(Object.keys(shape)).toEqual([]);
  });

  it("preserves descriptions on primitive properties", () => {
    const shape = toMcpToolShape("search_actions", {
      type: "object",
      properties: {
        query: { type: "string", description: "Regex pattern to match actions." },
      },
      required: ["query"],
    });
    // Description survives the conversion — important because it's the
    // model's main signal for free-form fields.
    expect(shape.query.description).toBe("Regex pattern to match actions.");
  });
});
