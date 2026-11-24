import { describe, expect, it, rs } from "@rstest/core";
import type { RomeToolGroup, RomeTools } from "../../../domain/rome-tools.js";
import {
  alignRomeDynamicToolsToInheritedCatalog,
  createRomeDynamicTools,
} from "./rome-dynamic-tools.js";

function fakeTools(definitions: Partial<Record<RomeToolGroup, readonly string[]>>): RomeTools {
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
      isError: name === "ask_question",
    })),
  };
}

describe("Rome dynamic tools", () => {
  it("delivers image blocks to the model while redacting computer-use outputs from activity", async () => {
    const romeTools = fakeTools({ computer: ["computer_observe"] });
    romeTools.callTool = async () => ({
      content: [
        { type: "text", text: "private AX contents" },
        { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
      ],
    });
    const result = await createRomeDynamicTools(romeTools).callTool("computer_observe", {});
    expect(result.response).toEqual({
      success: true,
      contentItems: [
        { type: "inputText", text: "private AX contents" },
        { type: "inputImage", imageUrl: "data:image/png;base64,aW1hZ2U=" },
      ],
    });
    expect(JSON.stringify(result.traceOutput)).not.toContain("aW1hZ2U=");
    expect(JSON.stringify(result.traceOutput)).not.toContain("private AX contents");
  });

  it("omits raw image bytes from activity for non-computer tools while preserving text", async () => {
    const romeTools = fakeTools({ actions: ["execute_action"] });
    romeTools.callTool = async () => ({
      content: [
        { type: "text", text: "public summary" },
        { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
      ],
    });
    const result = await createRomeDynamicTools(romeTools).callTool("execute_action", {});
    expect(JSON.stringify(result.traceOutput)).not.toContain("aW1hZ2U=");
    expect(JSON.stringify(result.traceOutput)).toContain("public summary");
  });
  it("flattens every tool group and preserves schemas, errors, trace output, and call ids", async () => {
    const romeTools = fakeTools({
      actions: ["execute_action"],
      subagents: ["researcher"],
      skills: ["read_skill"],
      ask_user: ["ask_question"],
    });
    const tools = createRomeDynamicTools(romeTools);

    expect(tools.definitions.map((definition) => definition.name)).toEqual([
      "execute_action",
      "researcher",
      "read_skill",
      "ask_question",
    ]);
    expect(tools.definitions[0]).toMatchObject({
      type: "function",
      name: "execute_action",
      inputSchema: { type: "object", properties: {} },
    });

    const result = await tools.callTool(
      "ask_question",
      { value: 1 },
      { toolUseId: "call-question" },
    );
    expect(romeTools.callTool).toHaveBeenCalledWith(
      "ask_user",
      "ask_question",
      { value: 1 },
      { toolUseId: "call-question" },
    );
    expect(result.response).toEqual({
      contentItems: [{ type: "inputText", text: "ask_question result" }],
      success: false,
    });
    expect(result.traceOutput).toEqual({
      content: [{ type: "text", text: "ask_question result" }],
      isError: true,
    });
  });

  it("rejects duplicate names across tool groups", () => {
    const romeTools = fakeTools({ actions: ["duplicate"], skills: ["duplicate"] });
    expect(() => createRomeDynamicTools(romeTools)).toThrow(
      "Duplicate Rome dynamic tool name: duplicate (actions, skills)",
    );
  });

  it("fails closed for unknown tools and non-object arguments", async () => {
    const tools = createRomeDynamicTools(fakeTools({ actions: ["known"] }));
    await expect(tools.callTool("missing", {})).resolves.toMatchObject({
      response: { success: false },
      traceOutput: { isError: true },
    });
    await expect(tools.callTool("known", "not-an-object")).resolves.toMatchObject({
      response: { success: false },
      traceOutput: { isError: true },
    });
  });

  it("keeps a native fork aligned with its inherited catalog but fails closed for disabled tools", async () => {
    const sourceTools = createRomeDynamicTools(fakeTools({ subagents: ["source_researcher"] }));
    const forkRomeTools = fakeTools({ actions: ["fork_action"] });
    const forkTools = alignRomeDynamicToolsToInheritedCatalog(
      createRomeDynamicTools(forkRomeTools),
      sourceTools.definitions,
    );

    expect(forkTools.definitions).toEqual(sourceTools.definitions);
    expect(forkTools.hasTool("source_researcher")).toBe(true);
    expect(forkTools.hasTool("fork_action")).toBe(false);
    await expect(forkTools.callTool("source_researcher", { prompt: "inspect" })).resolves.toEqual({
      response: {
        contentItems: [
          {
            type: "inputText",
            text: "Dynamic tool is disabled in this fork: source_researcher",
          },
        ],
        success: false,
      },
      traceOutput: {
        content: [
          { type: "text", text: "Dynamic tool is disabled in this fork: source_researcher" },
        ],
        isError: true,
      },
    });
    expect(forkRomeTools.callTool).not.toHaveBeenCalled();
  });
});
