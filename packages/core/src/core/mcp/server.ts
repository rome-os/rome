import type { ModelSessionForkOpenParams } from "../agent-runner.js";
import {
  buildFacadeBundle,
  type FacadeBundle,
  type FacadeParams,
  type FacadeToolDef,
  type FacadeToolResult,
} from "../mcp-facade.js";
import type { ModelToolCallContext } from "../agent-runner.js";

export type RomeMcpGroup = "actions" | "subagents" | "skills" | "output" | "ask_user";

export interface RomeMcpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface RomeMcpServer {
  listTools(group: RomeMcpGroup): readonly RomeMcpToolDefinition[];
  callTool(
    group: RomeMcpGroup,
    name: string,
    input?: Record<string, unknown>,
    context?: ModelToolCallContext,
  ): Promise<FacadeToolResult>;
}

function toolsForGroup(bundle: FacadeBundle, group: RomeMcpGroup): FacadeToolDef[] {
  switch (group) {
    case "actions":
      return bundle.actions;
    case "subagents":
      return bundle.subagents;
    case "skills":
      return bundle.skills;
    case "output":
      return bundle.submitOutput;
    case "ask_user":
      return bundle.interactiveTools;
  }
}

/**
 * The single session-params → FacadeParams mapping. Every server built for a
 * model session (fresh open or borrowed exact-fork turn) must go through this
 * so a new facade capability can't be wired into one path and silently
 * dropped from the other.
 */
export function createRomeMcpServerForSession(params: ModelSessionForkOpenParams): RomeMcpServer {
  return createRomeMcpServer({
    getActionCatalog: params.getActionCatalog,
    getSkillCatalog: params.getSkillCatalog,
    subagentTools: params.subagentTools,
    handback: params.handback,
    executeAction: params.executeAction,
    executeSubagent: params.executeSubagent,
    executeSubmitOutput: params.executeSubmitOutput,
    supportsInteractiveSurface: params.supportsInteractiveSurface,
    interactiveSurfaceDetached: params.interactiveSurfaceDetached,
    executeDefer: params.executeDefer,
  });
}

export function createRomeMcpServer(params: FacadeParams): RomeMcpServer {
  const bundle = buildFacadeBundle(params);

  return {
    listTools(group) {
      return Object.freeze(
        toolsForGroup(bundle, group).map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      );
    },
    async callTool(group, name, input = {}, context) {
      const tool = toolsForGroup(bundle, group).find((candidate) => candidate.name === name);
      if (!tool) {
        return {
          content: [{ type: "text", text: `Unknown MCP tool: ${name}` }],
          isError: true,
        };
      }
      return await tool.handler(input, context);
    },
  };
}
