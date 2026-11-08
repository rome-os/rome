// Anthropic-side mount of the Rome tools.
//
// The tool definitions and handlers are the run's, served as `RomeTools`.
// This module's job is to wrap each tool into the
// Claude Agent SDK's `tool()` shape and group them under `createSdkMcpServer()`
// instances, then attach any external (stdio) MCP servers the agent declared.
//
// Conversion notes:
//   - The Claude SDK's `tool()` wants a zod shape, not raw JSON Schema. We
//     reconstruct one via `zod-from-json-schema` so nested arrays/objects
//     keep their item/property shape — flattening to `z.array(z.any())` would
//     hide structure from clients that re-serialize the advertised schema.
//   - A Rome tool already answers `{ content, isError? }` (the MCP standard
//     `CallToolResult`), so we pass that through unchanged.

import { createSdkMcpServer, tool as sdkTool } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerConfig } from "../../../domain/model-port.js";
import type { RomeToolDefinition, RomeToolGroup, RomeTools } from "../../../domain/rome-tools.js";
import { toMcpToolShape } from "./json-schema-zod.js";

interface BuildAnthropicMcpServersParams {
  tools: RomeTools;
  externalMcpServers?: Record<string, McpServerConfig>;
}

export type AnthropicMcpServers = Record<
  string,
  ReturnType<typeof createSdkMcpServer> | McpServerConfig
>;

/** The name Claude Code gives a Rome tool: `mcp__<group>__<tool>`. */
export function anthropicToolName(group: RomeToolGroup, tool: RomeToolDefinition): string {
  return `mcp__${group}__${tool.name}`;
}

// The Claude Agent SDK's `tool()` callback is generically typed against the
// zod shape it's given, and its return type covers the full
// `text/image/audio/resource` block union. Rome's tools always answer with
// text blocks. Pipe through an `unknown`-cast `sdkTool` to skirt the inference.
function wrapRomeTool(tools: RomeTools, group: RomeToolGroup, toolDef: RomeToolDefinition) {
  const wrappedSdkTool = sdkTool as unknown as (
    name: string,
    description: string,
    shape: Record<string, unknown>,
    cb: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>,
  ) => ReturnType<typeof sdkTool>;
  return wrappedSdkTool(
    toolDef.name,
    toolDef.description,
    toMcpToolShape(toolDef.name, toolDef.inputSchema),
    async (args: Record<string, unknown>, extra: unknown) => {
      const meta =
        extra && typeof extra === "object" && "_meta" in extra
          ? (extra as { _meta?: Record<string, unknown> })._meta
          : undefined;
      // Claude Agent SDK currently exposes the provider tool-use identity via
      // this metadata key. Re-check it whenever upgrading the SDK: changing or
      // removing the key breaks parent-child subagent association.
      const toolUseId = meta?.["claudecode/toolUseId"];
      return tools.callTool(
        group,
        toolDef.name,
        args ?? {},
        typeof toolUseId === "string" ? { toolUseId } : undefined,
      );
    },
  );
}

export function buildAnthropicMcpServers({
  tools,
  externalMcpServers,
}: BuildAnthropicMcpServersParams): AnthropicMcpServers {
  const server = (group: RomeToolGroup) =>
    createSdkMcpServer({
      name: group,
      tools: tools.listTools(group).map((toolDef) => wrapRomeTool(tools, group, toolDef)),
    });

  // The actions + skills MCP servers always register so the agent can list
  // them mid-session even when the live catalogs are currently empty — that's
  // how `app_management` installs become discoverable in-session.
  const mcpServers: AnthropicMcpServers = {
    actions: server("actions"),
    skills: server("skills"),
  };

  // Tools that hand something back to the human to answer. Registered when the
  // run serves any.
  if (tools.listTools("ask_user").length > 0) {
    mcpServers.ask_user = server("ask_user");
  }

  if (tools.listTools("subagents").length > 0) {
    mcpServers.subagents = server("subagents");
  }

  if (externalMcpServers) {
    for (const [name, config] of Object.entries(externalMcpServers)) {
      mcpServers[name] = config;
    }
  }

  return mcpServers;
}
