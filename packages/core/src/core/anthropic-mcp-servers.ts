// Anthropic-side adapter for the provider-agnostic MCP facade.
//
// The actual tool definitions (list_actions / read_action / … and the
// skill / subagent counterparts) live in `mcp-facade.ts`. This module's job
// is to wrap each facade tool into the Claude Agent SDK's `tool()` shape and
// group them under `createSdkMcpServer()` instances, then attach any
// external (stdio) MCP servers the agent declared.
//
// Conversion notes:
//   - The Claude SDK's `tool()` wants a zod shape, not raw JSON Schema. We
//     reconstruct one via `zod-from-json-schema` so nested arrays/objects
//     keep their item/property shape — flattening to `z.array(z.any())` would
//     hide structure from clients that re-serialize the advertised schema.
//   - The facade handler already returns `{ content, isError? }` (the MCP
//     standard `CallToolResult`), so we pass that through unchanged.

import { createSdkMcpServer, tool as sdkTool } from "@anthropic-ai/claude-agent-sdk";
import { toMcpToolShape } from "./mcp/json-schema-zod.js";
import type { McpServerConfig } from "../types.js";
import type { DeferInput } from "./defer.js";
import type {
  ActionMcpDefinition,
  ModelToolCallContext,
  ModelToolDefinition,
  SkillMcpDefinition,
} from "./agent-runner.js";
import type { HandbackSpec } from "./mcp-facade.js";
import {
  createRomeMcpServer,
  type RomeMcpGroup,
  type RomeMcpServer,
  type RomeMcpToolDefinition,
} from "./mcp/server.js";

interface BuildAnthropicMcpServersParams {
  /** See FacadeParams.getActionCatalog. */
  getActionCatalog: () => ActionMcpDefinition[];
  /** See FacadeParams.getSkillCatalog. */
  getSkillCatalog: () => SkillMcpDefinition[];
  subagentTools: ModelToolDefinition[];
  handback?: HandbackSpec;
  externalMcpServers?: Record<string, McpServerConfig>;
  executeAction: (name: string, input: unknown) => Promise<unknown>;
  executeSubagent: (
    name: string,
    input: unknown,
    context: ModelToolCallContext,
  ) => Promise<unknown>;
  executeSubmitOutput?: (input: unknown) => Promise<unknown>;
  /** See FacadeParams.supportsInteractiveSurface. */
  supportsInteractiveSurface?: boolean;
  /** See FacadeParams.interactiveSurfaceDetached. */
  interactiveSurfaceDetached?: boolean;
  /** See FacadeParams.executeDefer. */
  executeDefer?: (input: DeferInput) => Promise<unknown>;
}

export type AnthropicMcpServers = Record<
  string,
  ReturnType<typeof createSdkMcpServer> | McpServerConfig
>;

// The Claude Agent SDK's `tool()` callback is generically typed against the
// zod shape it's given, and its return type covers the full
// `text/image/audio/resource` block union. Our facade always emits text
// blocks. Pipe through an `unknown`-cast `sdkTool` to skirt the inference.
function wrapFacadeTool(
  server: RomeMcpServer,
  group: RomeMcpGroup,
  toolDef: RomeMcpToolDefinition,
) {
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
      return server.callTool(
        group,
        toolDef.name,
        args ?? {},
        typeof toolUseId === "string" ? { toolUseId } : undefined,
      );
    },
  );
}

export function buildAnthropicMcpServers({
  getActionCatalog,
  getSkillCatalog,
  subagentTools,
  handback,
  externalMcpServers,
  executeAction,
  executeSubagent,
  executeSubmitOutput,
  supportsInteractiveSurface,
  interactiveSurfaceDetached,
  executeDefer,
}: BuildAnthropicMcpServersParams): AnthropicMcpServers {
  const server = createRomeMcpServer({
    getActionCatalog,
    getSkillCatalog,
    subagentTools,
    handback,
    executeAction,
    executeSubagent,
    executeSubmitOutput,
    supportsInteractiveSurface,
    interactiveSurfaceDetached,
    executeDefer,
  });

  // The actions + skills MCP servers always register so the agent can list
  // them mid-session even when the live getters currently return [] — that's
  // how `app_management` installs become discoverable in-session.
  const mcpServers: AnthropicMcpServers = {
    actions: createSdkMcpServer({
      name: "actions",
      tools: server
        .listTools("actions")
        .map((toolDef) => wrapFacadeTool(server, "actions", toolDef)),
    }),
    skills: createSdkMcpServer({
      name: "skills",
      tools: server.listTools("skills").map((toolDef) => wrapFacadeTool(server, "skills", toolDef)),
    }),
  };

  // Built-in tools that hand interactive inline UI back to the human
  // (propose_routine). Only register when the consuming surface can actually
  // render it — see FacadeParams.supportsInteractiveSurface.
  const interactiveTools = server.listTools("ask_user");
  if (interactiveTools.length > 0) {
    mcpServers.ask_user = createSdkMcpServer({
      name: "ask_user",
      tools: interactiveTools.map((toolDef) => wrapFacadeTool(server, "ask_user", toolDef)),
    });
  }

  const subagentToolsBundle = server.listTools("subagents");
  if (subagentToolsBundle.length > 0) {
    mcpServers.subagents = createSdkMcpServer({
      name: "subagents",
      tools: subagentToolsBundle.map((toolDef) => wrapFacadeTool(server, "subagents", toolDef)),
    });
  }

  const outputTools = server.listTools("output");
  if (outputTools.length > 0) {
    mcpServers.output = createSdkMcpServer({
      name: "output",
      tools: outputTools.map((toolDef) => wrapFacadeTool(server, "output", toolDef)),
    });
  }

  if (externalMcpServers) {
    for (const [name, config] of Object.entries(externalMcpServers)) {
      mcpServers[name] = config;
    }
  }

  return mcpServers;
}
