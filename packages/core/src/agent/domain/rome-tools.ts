// The tools Rome serves to the model during a turn. A port the run
// implements and the model port's adapters call: the adapter mounts each
// group as its own server or tool set and never reads a tool's meaning.
// Built once per open; a group's catalog may change between calls.

/** Value. The provider's id for one tool call within a turn. */
export type ToolUseId = string;

/** The groups Rome serves tools in. */
export type RomeToolGroup = "actions" | "subagents" | "skills" | "ask_user";

export interface ModelToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * A call parks the turn on something the person answers in a later turn,
   * so the model ends its response with no text after it. An adapter whose
   * model guards against a turn with no visible text tells it such a result
   * finishes the turn. Absent means the call returns and the turn goes on.
   */
  endsTurn?: boolean;
}

export interface ModelToolCallContext {
  toolUseId: ToolUseId;
}

/** Value object. A tool's answer as the adapter relays it to the model. */
export interface RomeToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface RomeTools {
  listTools(group: RomeToolGroup): readonly ModelToolDefinition[];
  callTool(
    group: RomeToolGroup,
    name: string,
    input: Record<string, unknown> | undefined,
    context: ModelToolCallContext,
  ): Promise<RomeToolResult>;
}
