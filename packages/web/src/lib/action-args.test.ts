import { describe, expect, it } from "@rstest/core";
import type { ActionInputSchema } from "@/hooks/use-action-catalog";
import {
  buildArgsTemplate,
  describeArgType,
  evaluateArgsText,
  validateArgsAgainstSchema,
} from "./action-args";

const schema: ActionInputSchema = {
  type: "object",
  properties: {
    message: { type: "string", description: "What to send" },
    channel: { type: "string", enum: ["telegram", "webchat"] },
    count: { type: "integer" },
    verbose: { type: "boolean", default: true },
    tags: { type: "array", items: { type: "string" } },
  },
  required: ["message", "channel"],
};

describe("buildArgsTemplate", () => {
  it("seeds every required property with a placeholder", () => {
    expect(JSON.parse(buildArgsTemplate(schema))).toEqual({
      message: "",
      channel: "telegram", // first enum value
    });
  });

  it("prefers the schema default over the type zero value", () => {
    const withDefault: ActionInputSchema = {
      properties: { verbose: { type: "boolean", default: true } },
      required: ["verbose"],
    };
    expect(JSON.parse(buildArgsTemplate(withDefault))).toEqual({ verbose: true });
  });

  it("returns {} when there is no schema or nothing is required", () => {
    expect(buildArgsTemplate(null)).toBe("{}");
    expect(buildArgsTemplate({ properties: { a: { type: "string" } } })).toBe("{}");
  });

  it("falls back to an empty string for a required key without a property", () => {
    expect(JSON.parse(buildArgsTemplate({ required: ["mystery"] }))).toEqual({ mystery: "" });
  });
});

describe("validateArgsAgainstSchema", () => {
  it("accepts args that satisfy the schema", () => {
    expect(
      validateArgsAgainstSchema({ message: "hi", channel: "webchat", count: 2 }, schema),
    ).toEqual([]);
  });

  it("rejects enum values outside the declared set", () => {
    expect(validateArgsAgainstSchema({ message: "hi", channel: "bogus" }, schema)).toEqual([
      {
        kind: "schema",
        path: "channel",
        message: "must be equal to one of the allowed values",
      },
    ]);
  });

  it("enforces composed conditional requirements", () => {
    const conditional: ActionInputSchema = {
      type: "object",
      properties: {
        op: { type: "string", enum: ["install", "uninstall"] },
        source: {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["source", "bundle"] },
            path: { type: "string" },
          },
          required: ["mode"],
          allOf: [
            {
              if: { properties: { mode: { const: "source" } }, required: ["mode"] },
              then: { required: ["path"] },
            },
          ],
        },
      },
      required: ["op"],
      allOf: [
        {
          if: { properties: { op: { const: "install" } }, required: ["op"] },
          then: { required: ["source"] },
        },
      ],
    };

    expect(validateArgsAgainstSchema({ op: "install" }, conditional)).toContainEqual({
      kind: "missing",
      name: "source",
    });
    expect(
      validateArgsAgainstSchema({ op: "install", source: { mode: "source" } }, conditional),
    ).toContainEqual({ kind: "missing", name: "source.path" });
    expect(
      validateArgsAgainstSchema(
        { op: "install", source: { mode: "source", path: "/tmp/app" } },
        conditional,
      ),
    ).toEqual([]);
  });

  it("validates draft 2020-12 tuple constraints", () => {
    const tuple: ActionInputSchema = {
      type: "object",
      properties: {
        coordinates: {
          type: "array",
          prefixItems: [{ type: "number" }, { type: "number" }],
          items: false,
        },
      },
      required: ["coordinates"],
    };

    expect(validateArgsAgainstSchema({ coordinates: [1, 2] }, tuple)).toEqual([]);
    expect(validateArgsAgainstSchema({ coordinates: ["x", 2] }, tuple)).toContainEqual({
      kind: "type",
      name: "coordinates.0",
      expected: "number",
    });
  });

  it("flags missing required keys", () => {
    expect(validateArgsAgainstSchema({ message: "hi" }, schema)).toEqual([
      { kind: "missing", name: "channel" },
    ]);
  });

  it("flags type mismatches, including integer vs float", () => {
    const issues = validateArgsAgainstSchema(
      { message: 5, channel: "webchat", count: 1.5 },
      schema,
    );
    expect(issues).toEqual([
      { kind: "type", name: "message", expected: "string" },
      { kind: "type", name: "count", expected: "integer" },
    ]);
  });

  it("accepts union types when one branch matches", () => {
    const union: ActionInputSchema = {
      properties: { id: { type: ["string", "number"] } },
    };
    expect(validateArgsAgainstSchema({ id: 7 }, union)).toEqual([]);
    expect(validateArgsAgainstSchema({ id: true }, union)).toEqual([
      { kind: "type", name: "id", expected: "string | number" },
    ]);
  });

  it("ignores extra keys unless additionalProperties is false", () => {
    expect(validateArgsAgainstSchema({ message: "hi", channel: "webchat", x: 1 }, schema)).toEqual(
      [],
    );
    const closed: ActionInputSchema = { ...schema, additionalProperties: false };
    expect(validateArgsAgainstSchema({ message: "hi", channel: "webchat", x: 1 }, closed)).toEqual([
      { kind: "unknown", name: "x" },
    ]);
  });

  it("fails closed when the action publishes an invalid schema", () => {
    const odd: ActionInputSchema = { properties: { blob: { type: "binary" } } };
    expect(validateArgsAgainstSchema({ blob: 42 }, odd)).toEqual([
      expect.objectContaining({
        kind: "schema",
        path: "args",
        message: expect.stringContaining("schema could not be evaluated"),
      }),
    ]);
  });
});

describe("evaluateArgsText", () => {
  it("only reports valid after a schema-backed full validation", () => {
    expect(evaluateArgsText("{}", null).kind).toBe("unvalidated");
    expect(evaluateArgsText('{"message":"hi","channel":"bogus"}', schema).kind).toBe("invalid");
    expect(evaluateArgsText('{"message":"hi","channel":"webchat"}', schema).kind).toBe("valid");
  });
});

describe("describeArgType", () => {
  it("labels single, union, and untyped properties", () => {
    expect(describeArgType({ type: "string" })).toBe("string");
    expect(describeArgType({ type: ["string", "number"] })).toBe("string | number");
    expect(describeArgType({})).toBe("any");
  });
});
