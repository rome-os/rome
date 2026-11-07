// The tools Rome serves to the model during a turn. The run builds them from
// the agent's actions, subagents, skills and the surface the guardian answers
// on; the provider mounts them under their groups and calls them back with
// what the model sent. Agent model: docs/concepts/agents.md.

/**
 * Value. The id the provider gave one tool call. Unique within the thread. A
 * tool result, an approval answer or an `injectedToolResult` carrying it
 * continues exactly that call, and the provider rejects one for a call it
 * does not have open. The adapter passes it through from the provider's call
 * event; the run never mints one.
 */
export type ModelToolCallId = string;

/** The groups Rome serves tools in. A provider mounts each group as one server. */
export const ROME_TOOL_GROUPS = ["actions", "subagents", "skills", "ask_user"] as const;

export type RomeToolGroup = (typeof ROME_TOOL_GROUPS)[number];

export interface RomeToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. Adapters translate as needed. */
  inputSchema: Record<string, unknown>;
  /**
   * A call parks the turn on something the person answers in a later turn, so
   * the model ends its response with no text after it. An adapter whose model
   * guards against a turn with no visible text tells it such a result finishes
   * the turn. Absent means the call returns and the turn goes on.
   */
  endsTurn?: boolean;
}

export interface ModelToolCallContext {
  toolUseId: ModelToolCallId;
}

/** Value object. A tool's answer as the adapter relays it to the model. */
export interface RomeToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export type RomeToolHandler = (
  input: Record<string, unknown>,
  context?: ModelToolCallContext,
) => Promise<RomeToolResult>;

/** A Rome tool with the handler that runs it. */
export interface RomeTool extends RomeToolDefinition {
  handler: RomeToolHandler;
}

/** The same tools with handlers that refuse: a forked turn advertises its source's catalog unchanged. */
export function detachSessionTools(tools: readonly RomeTool[]): RomeTool[] {
  return tools.map((tool) => ({
    ...tool,
    handler: async () => ({
      content: [{ type: "text", text: `${tool.name} is unavailable in a forked turn.` }],
      isError: true,
    }),
  }));
}

/** The subagents this agent may hand work to, each served as a tool. */
export interface Subagents {
  tools: readonly RomeToolDefinition[];
  run(name: string, input: unknown, call: ModelToolCallContext): Promise<unknown>;
}

export interface RomeTools {
  listTools(group: RomeToolGroup): readonly RomeToolDefinition[];
  /**
   * Run one tool. An unknown name or a failing tool comes back as an error
   * result for the model, never as a thrown error. The context is absent only
   * when the provider gave the call no id.
   */
  callTool(
    group: RomeToolGroup,
    name: string,
    input: Record<string, unknown> | undefined,
    context?: ModelToolCallContext,
  ): Promise<RomeToolResult>;
}

/** The empty tool surface: a session that serves the model nothing. */
export const NO_ROME_TOOLS: RomeTools = {
  listTools: () => [],
  callTool: async (_group, name) => ({
    content: [{ type: "text", text: `Unknown tool: ${name}` }],
    isError: true,
  }),
};
