import { describe, it, expect } from "@rstest/core";
import { z } from "zod";
import { jsonSchemaObjectToZodRawShape } from "zod-from-json-schema";
import type { JSONSchema } from "zod/v4/core";
import { buildFacadeBundle, type FacadeToolDef } from "./mcp-facade.js";
import { toMcpToolShape } from "./mcp/json-schema-zod.js";

// Every built-in tool the facade can offer, with each optional group switched on.
function allBuiltInTools(): FacadeToolDef[] {
  const bundle = buildFacadeBundle({
    getActionCatalog: () => [],
    getSkillCatalog: () => [],
    subagentTools: [],
    executeAction: async () => ({}),
    executeSubagent: async () => ({}),
    executeSubmitOutput: async () => ({}),
    executeDefer: async () => ({}),
    supportsInteractiveSurface: true,
    handback: { schema: { type: "object", properties: { a: { type: "string" } } } },
    routineActivation: {
      canCallAction: () => "permitted",
      validateArgs: () => null,
      routineKeyFor: () => undefined,
    },
  });
  return [
    ...bundle.actions,
    ...bundle.subagents,
    ...bundle.skills,
    ...bundle.submitOutput,
    ...bundle.interactiveTools,
  ];
}

function findTool(name: string): FacadeToolDef {
  const tool = allBuiltInTools().find((t) => t.name === name);
  if (!tool) throw new Error(`missing built-in tool ${name}`);
  return tool;
}

// The Claude path converts each inputSchema to zod and re-serializes it for
// tools/list. A schema that cannot make that round trip falls back to a flat
// shape and loses its nested item shapes, so every built-in must survive it.
describe("facade tool input schemas", () => {
  it("offers every optional built-in when each option is on", () => {
    expect(allBuiltInTools().map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "execute_action",
        "submit_output",
        "ask_question",
        "defer",
        "confirm_output",
        "propose_routine",
      ]),
    );
  });

  it.each(
    allBuiltInTools().map((t) => [t.name, t] as const),
  )("%s survives the zod round trip without the flat fallback", (name, tool) => {
    // Without the fallback, toMcpToolShape advertises exactly the full conversion.
    const full = z.toJSONSchema(
      z.object(jsonSchemaObjectToZodRawShape(tool.inputSchema as JSONSchema.Schema)),
    );
    const advertised = z.toJSONSchema(z.object(toMcpToolShape(name, tool.inputSchema)));
    expect(advertised).toEqual(full);
  });

  it("advertises propose_routine's filter conditions with their item shape", () => {
    const shape = toMcpToolShape("propose_routine", findTool("propose_routine").inputSchema);
    const advertised = z.toJSONSchema(z.object(shape)) as {
      properties: Record<string, { items?: { properties?: object; required?: string[] } }>;
    };
    const items = advertised.properties.filter.items;
    expect(Object.keys(items?.properties ?? {})).toEqual(
      expect.arrayContaining(["field", "equals"]),
    );
    expect(items?.required).toEqual(expect.arrayContaining(["field", "equals"]));
  });

  it("keeps every key of propose_routine's free-form args", () => {
    const shape = toMcpToolShape("propose_routine", findTool("propose_routine").inputSchema);
    const args = { agentName: "main", prompt: "Summarize the email.", nested: { n: 1 } };
    const parsed = z.object(shape).parse({
      kind: "manual",
      sentence: "Rome will summarize your inbox when you run it.",
      name: "Inbox summary",
      watchLabel: "Run manually",
      thenSummary: "summarize your inbox",
      actionName: "summon",
      args,
    });
    expect(parsed.args).toEqual(args);
  });
});
