import type { RomeTool, RomeToolDefinition, RomeToolGroup, RomeTools } from "../../agent/index.js";
import { buildFacadeBundle, type FacadeBundle, type FacadeParams } from "../mcp-facade.js";

function toolsForGroup(bundle: FacadeBundle, group: RomeToolGroup): RomeTool[] {
  switch (group) {
    case "actions":
      return bundle.actions;
    case "subagents":
      return bundle.subagents;
    case "skills":
      return bundle.skills;
    case "ask_user":
      return bundle.interactiveTools;
  }
}

function toDefinition({ name, description, inputSchema, endsTurn }: RomeTool): RomeToolDefinition {
  return { name, description, inputSchema, ...(endsTurn !== undefined ? { endsTurn } : {}) };
}

/**
 * The Rome tools a model session serves, built once from the run's facade
 * params. Every model session (a fresh open or an exact fork's turn) gets its
 * tools from here, so a new facade capability reaches both.
 */
export function createRomeTools(params: FacadeParams): RomeTools {
  const bundle = buildFacadeBundle(params);

  return {
    listTools(group) {
      return Object.freeze(toolsForGroup(bundle, group).map(toDefinition));
    },
    async callTool(group, name, input = {}, context) {
      const tool = toolsForGroup(bundle, group).find((candidate) => candidate.name === name);
      if (!tool) {
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
      }
      return await tool.handler(input, context);
    },
  };
}
