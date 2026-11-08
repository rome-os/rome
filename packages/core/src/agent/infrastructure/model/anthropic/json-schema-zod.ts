// Convert a tool's JSON Schema into the zod raw shape the MCP SDK's
// `tool()` / `registerTool()` APIs want.
//
// We prefer `zod-from-json-schema`, which recurses through `items` /
// nested `properties` so clients see the real item shape of an
// `array<object>` parameter. It does this via zod features like
// `.superRefine()` for `allOf`/`if`/`then`, which `z.toJSONSchema()`
// (and the SDK's equivalent `toJsonSchemaCompat`) cannot represent —
// when an agent declares an `outputSchema` containing conditionals,
// the SDK would throw `Custom types cannot be represented in JSON
// Schema` while serving `tools/list`.
//
// To avoid that, we pre-flight every conversion by round-tripping the
// resulting zod object through `z.toJSONSchema`. If the round trip
// throws, we fall back to a flat per-property shape. That fallback loses
// nested item shapes but keeps `tools/list` working for tools the SDK
// can't fully serialize.

import { z } from "zod";
import { jsonSchemaObjectToZodRawShape } from "zod-from-json-schema";
import type { JSONSchema } from "zod/v4/core";
import { createLogger } from "../../../../logger.js";

const log = createLogger("mcp-schema");

export function toMcpToolShape(
  toolName: string,
  inputSchema: Record<string, unknown>,
): Record<string, z.ZodType> {
  try {
    const shape = jsonSchemaObjectToZodRawShape(inputSchema as JSONSchema.Schema);
    // Pre-flight: confirm the SDK can re-serialize this shape back to JSON
    // Schema for `tools/list`. Mirrors what the SDK's `toJsonSchemaCompat`
    // will do at advertisement time.
    z.toJSONSchema(z.object(shape));
    return shape;
  } catch (err) {
    log.warn("falling back to flat schema; advertised tool schema will lose nested shape", {
      tool: toolName,
      error: err instanceof Error ? err.message : String(err),
    });
    return flatShapeFallback(inputSchema);
  }
}

// Only looks at top-level properties; collapses arrays/objects to
// `z.array(z.any())` / `z.record(z.string(), z.any())`.
function flatShapeFallback(schema: Record<string, unknown>): Record<string, z.ZodType> {
  const properties = (schema.properties || {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required || []) as string[];
  const shape: Record<string, z.ZodType> = {};
  for (const [key, prop] of Object.entries(properties)) {
    let zodType = flatProperty(prop);
    if (typeof prop.description === "string" && prop.description) {
      zodType = zodType.describe(prop.description);
    }
    if (!required.includes(key)) {
      zodType = zodType.optional();
    }
    shape[key] = zodType;
  }
  return shape;
}

function flatProperty(prop: Record<string, unknown>): z.ZodType {
  switch (prop.type) {
    case "string":
      return prop.enum ? z.enum(prop.enum as [string, ...string[]]) : z.string();
    case "number":
      return z.number();
    case "integer":
      return z.number().int();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(z.any());
    case "object":
      return z.record(z.string(), z.any());
    default:
      return z.any();
  }
}
