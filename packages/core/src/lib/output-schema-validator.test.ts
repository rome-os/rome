import { describe, expect, it } from "@rstest/core";
import {
  compileOutputSchema,
  PortableOutputSchemaError,
  validatePortableOutputSchema,
} from "./output-schema-validator.js";

const validSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    note: { type: ["string", "null"] },
    items: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: { count: { type: "integer", minimum: 0 } },
        required: ["count"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "note", "items"],
  additionalProperties: false,
} satisfies Record<string, unknown>;

function stringEnumWithTotalLength(count: number, totalLength: number): string[] {
  const prefixes = Array.from({ length: count }, (_, index) => `${index}:`);
  const prefixLength = prefixes.reduce((total, prefix) => total + prefix.length, 0);
  const remainingLength = totalLength - prefixLength;
  const baseSuffixLength = Math.floor(remainingLength / count);
  const remainder = remainingLength % count;
  return prefixes.map(
    (prefix, index) => prefix + "x".repeat(baseSuffixLength + (index < remainder ? 1 : 0)),
  );
}

function schemaWithEnum(values: unknown[]): Record<string, unknown> {
  return {
    type: "object",
    properties: { value: { type: "string", enum: values } },
    required: ["value"],
    additionalProperties: false,
  };
}

describe("portable-v1 outputSchema", () => {
  it("accepts nested strict objects, arrays, and required nullable values", () => {
    expect(validatePortableOutputSchema(validSchema)).toEqual([]);
    const compiled = compileOutputSchema(validSchema);
    expect(compiled.validate({ title: "ok", note: null, items: [{ count: 1 }] })).toBe(true);
  });

  it("rejects optional properties instead of rewriting their meaning", () => {
    const schema = {
      type: "object",
      properties: { optional: { type: "string" } },
      required: [],
      additionalProperties: false,
    };
    expect(() => compileOutputSchema(schema)).toThrow(PortableOutputSchemaError);
    expect(validatePortableOutputSchema(schema)).toEqual([
      expect.stringContaining("optional values must be required and nullable"),
    ]);
  });

  it("rejects root unions and unsupported JSON Schema keywords", () => {
    expect(
      validatePortableOutputSchema({
        type: ["object", "null"],
        properties: {},
        required: [],
        additionalProperties: false,
        anyOf: [],
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("$.anyOf is not supported"),
        expect.stringContaining("$.type must be the non-nullable type"),
      ]),
    );
  });

  it("rejects supported keywords when they do not apply to the declared type", () => {
    expect(
      validatePortableOutputSchema({
        type: "object",
        properties: {
          title: { type: "string", items: { type: "string" }, minimum: 1 },
        },
        required: ["title"],
        additionalProperties: false,
      }),
    ).toEqual(
      expect.arrayContaining([
        '$.properties["title"].items is only valid for array schemas',
        '$.properties["title"].minimum is only valid for numeric schemas',
      ]),
    );
  });

  it("applies the character limit only to names, enum values, and constants", () => {
    expect(
      validatePortableOutputSchema({
        type: "object",
        description: "x".repeat(120_001),
        properties: {},
        required: [],
        additionalProperties: false,
      }),
    ).toEqual([]);

    expect(
      validatePortableOutputSchema({
        type: "object",
        properties: {
          value: { type: "string", const: "x".repeat(120_001) },
        },
        required: ["value"],
        additionalProperties: false,
      }),
    ).toEqual([expect.stringContaining("characters across property names")]);
  });

  it("rejects schema values that JSON serialization cannot preserve", () => {
    expect(
      validatePortableOutputSchema({
        type: "object",
        properties: {
          value: { type: "number", const: Number.NaN },
        },
        required: ["value"],
        additionalProperties: false,
      }),
    ).toEqual([expect.stringContaining('["const"] must be a finite JSON number')]);

    expect(
      validatePortableOutputSchema({
        type: "object",
        properties: {
          value: { type: "number", minimum: Number.POSITIVE_INFINITY },
        },
        required: ["value"],
        additionalProperties: false,
      }),
    ).toEqual([expect.stringContaining('["minimum"] must be a finite JSON number')]);

    expect(validatePortableOutputSchema(schemaWithEnum(["ok", undefined]))).toEqual([
      expect.stringContaining('["enum"][1] contains a value that is not representable in JSON'),
    ]);
  });

  it("enforces the per-enum string character limit above 250 values", () => {
    expect(
      validatePortableOutputSchema(schemaWithEnum(stringEnumWithTotalLength(250, 15_001))),
    ).toEqual([]);
    expect(
      validatePortableOutputSchema(schemaWithEnum(stringEnumWithTotalLength(251, 15_000))),
    ).toEqual([]);
    expect(
      validatePortableOutputSchema(schemaWithEnum(stringEnumWithTotalLength(251, 15_001))),
    ).toEqual([
      expect.stringContaining(
        "enum contains 15001 string characters across more than 250 values; maximum is 15000",
      ),
    ]);
  });

  it("also rejects schemas that pass the profile shape but are invalid JSON Schema", () => {
    expect(() =>
      compileOutputSchema({
        type: "object",
        properties: {
          items: { type: "array", minItems: "one", items: { type: "string" } },
        },
        required: ["items"],
        additionalProperties: false,
      }),
    ).toThrow();
  });
});
