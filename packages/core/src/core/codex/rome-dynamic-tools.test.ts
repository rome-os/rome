import { describe, expect, it, rs } from "@rstest/core";
import type { RomeMcpGroup, RomeMcpServer } from "../mcp/server.js";
import { createRomeDynamicToolsFromServer } from "./rome-dynamic-tools.js";

function fakeServer(definitions: Partial<Record<RomeMcpGroup, readonly string[]>>): RomeMcpServer {
  return {
    listTools(group) {
      return (definitions[group] ?? []).map((name) => ({
        name,
        description: `${name} description`,
        inputSchema: { type: "object", properties: {} },
      }));
    },
    callTool: rs.fn(async (_group, name) => ({
      content: [{ type: "text" as const, text: `${name} result` }],
      isError: name === "submit_output",
    })),
  };
}

describe("Rome dynamic tools", () => {
  it("flattens every facade group and preserves schemas, errors, trace output, and call ids", async () => {
    const server = fakeServer({
      actions: ["execute_action"],
      subagents: ["researcher"],
      skills: ["read_skill"],
      output: ["submit_output"],
      ask_user: ["ask_question"],
    });
    const tools = createRomeDynamicToolsFromServer(server);

    expect(tools.definitions.map((definition) => definition.name)).toEqual([
      "execute_action",
      "researcher",
      "read_skill",
      "submit_output",
      "ask_question",
    ]);
    expect(tools.definitions[0]).toMatchObject({
      type: "function",
      name: "execute_action",
      inputSchema: { type: "object", properties: {} },
    });

    const result = await tools.callTool(
      "submit_output",
      { value: 1 },
      { toolUseId: "call-output" },
    );
    expect(server.callTool).toHaveBeenCalledWith(
      "output",
      "submit_output",
      { value: 1 },
      { toolUseId: "call-output" },
    );
    expect(result.response).toEqual({
      contentItems: [{ type: "inputText", text: "submit_output result" }],
      success: false,
    });
    expect(result.traceOutput).toEqual({
      content: [{ type: "text", text: "submit_output result" }],
      isError: true,
    });
  });

  it("rejects duplicate names across facade groups", () => {
    const server = fakeServer({ actions: ["duplicate"], skills: ["duplicate"] });
    expect(() => createRomeDynamicToolsFromServer(server)).toThrow(
      "Duplicate Rome dynamic tool name: duplicate (actions, skills)",
    );
  });

  it("fails closed for unknown tools and non-object arguments", async () => {
    const tools = createRomeDynamicToolsFromServer(fakeServer({ actions: ["known"] }));
    await expect(tools.callTool("missing", {})).resolves.toMatchObject({
      response: { success: false },
      traceOutput: { isError: true },
    });
    await expect(tools.callTool("known", "not-an-object")).resolves.toMatchObject({
      response: { success: false },
      traceOutput: { isError: true },
    });
  });
});
