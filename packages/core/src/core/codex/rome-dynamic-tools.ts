import type { ModelSessionForkOpenParams, ModelToolCallContext } from "../agent-runner.js";
import type { FacadeToolResult } from "../mcp-facade.js";
import {
  createRomeMcpServerForSession,
  type RomeMcpGroup,
  type RomeMcpServer,
} from "../mcp/server.js";
import type { DynamicToolCallResponse, DynamicToolSpec } from "./app-server-protocol.js";

const DYNAMIC_TOOL_GROUPS: readonly RomeMcpGroup[] = [
  "actions",
  "subagents",
  "skills",
  "output",
  "ask_user",
];

export interface RomeDynamicToolCallResult {
  response: DynamicToolCallResponse;
  traceOutput: FacadeToolResult;
}

export interface RomeDynamicTools {
  readonly definitions: readonly DynamicToolSpec[];
  hasTool(name: string): boolean;
  callTool(
    name: string,
    input: unknown,
    context?: ModelToolCallContext,
  ): Promise<RomeDynamicToolCallResult>;
}

function toDynamicResponse(result: FacadeToolResult): DynamicToolCallResponse {
  return {
    contentItems: result.content.map((item) => ({
      type: "inputText" as const,
      text: item.text,
    })),
    success: result.isError !== true,
  };
}

function errorResult(message: string): RomeDynamicToolCallResult {
  const traceOutput: FacadeToolResult = {
    content: [{ type: "text", text: message }],
    isError: true,
  };
  return { response: toDynamicResponse(traceOutput), traceOutput };
}

function recordInput(input: unknown): Record<string, unknown> | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  return input as Record<string, unknown>;
}

export function createRomeDynamicTools(params: ModelSessionForkOpenParams): RomeDynamicTools {
  return createRomeDynamicToolsFromServer(createRomeMcpServerForSession(params));
}

/**
 * `thread/fork` inherits the source thread's dynamic-tool definitions and the
 * current app-server protocol has no fork/resume field that can replace them.
 * Keep the child binding's advertised catalog identical to that inherited
 * catalog, while still enforcing the fork's Rome-side runtime permissions.
 *
 * An isolated fork therefore rejects an inherited source-only tool explicitly
 * instead of letting the manager report it as unknown (or accidentally routing
 * it through the source session's callbacks).
 */
export function alignRomeDynamicToolsToInheritedCatalog(
  runtimeTools: RomeDynamicTools,
  inheritedDefinitions: readonly DynamicToolSpec[],
): RomeDynamicTools {
  const definitions = [...inheritedDefinitions];
  const inheritedNames = new Set(definitions.map((definition) => definition.name));
  return {
    definitions,
    hasTool: (name) => inheritedNames.has(name),
    async callTool(name, input, context) {
      if (!inheritedNames.has(name)) return errorResult(`Unknown dynamic tool: ${name}`);
      if (!runtimeTools.hasTool(name)) {
        return errorResult(`Dynamic tool is disabled in this fork: ${name}`);
      }
      return await runtimeTools.callTool(name, input, context);
    },
  };
}

export function createRomeDynamicToolsFromServer(server: RomeMcpServer): RomeDynamicTools {
  const groupByName = new Map<string, RomeMcpGroup>();
  const definitions: DynamicToolSpec[] = [];

  for (const group of DYNAMIC_TOOL_GROUPS) {
    for (const tool of server.listTools(group)) {
      const previousGroup = groupByName.get(tool.name);
      if (previousGroup) {
        throw new Error(
          `Duplicate Rome dynamic tool name: ${tool.name} (${previousGroup}, ${group})`,
        );
      }
      groupByName.set(tool.name, group);
      definitions.push({
        type: "function",
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }
  }

  return {
    definitions,
    hasTool: (name) => groupByName.has(name),
    async callTool(name, input, context) {
      const group = groupByName.get(name);
      if (!group) return errorResult(`Unknown dynamic tool: ${name}`);
      const args = recordInput(input);
      if (!args) return errorResult(`Invalid arguments for dynamic tool: ${name}`);
      try {
        const traceOutput = await server.callTool(group, name, args, context);
        return { response: toDynamicResponse(traceOutput), traceOutput };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}
