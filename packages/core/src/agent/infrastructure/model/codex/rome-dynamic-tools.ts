import {
  type ModelToolCallContext,
  ROME_TOOL_GROUPS,
  type RomeToolGroup,
  type RomeToolResult,
  type RomeTools,
} from "../../../domain/rome-tools.js";
import type { DynamicToolCallResponse, DynamicToolSpec } from "./app-server-protocol.js";

export interface RomeDynamicToolCallResult {
  response: DynamicToolCallResponse;
  traceOutput: RomeToolResult;
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

function toDynamicResponse(result: RomeToolResult): DynamicToolCallResponse {
  return {
    contentItems: result.content.map((item) => ({
      type: "inputText" as const,
      text: item.text,
    })),
    success: result.isError !== true,
  };
}

function errorResult(message: string): RomeDynamicToolCallResult {
  const traceOutput: RomeToolResult = {
    content: [{ type: "text", text: message }],
    isError: true,
  };
  return { response: toDynamicResponse(traceOutput), traceOutput };
}

function recordInput(input: unknown): Record<string, unknown> | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  return input as Record<string, unknown>;
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

/** Flatten the Rome tools into one app-server dynamic-tool catalog. */
export function createRomeDynamicTools(tools: RomeTools): RomeDynamicTools {
  const groupByName = new Map<string, RomeToolGroup>();
  const definitions: DynamicToolSpec[] = [];

  for (const group of ROME_TOOL_GROUPS) {
    for (const tool of tools.listTools(group)) {
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
        const traceOutput = await tools.callTool(group, name, args, context);
        return { response: toDynamicResponse(traceOutput), traceOutput };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}
