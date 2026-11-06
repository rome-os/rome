// The tools Rome serves to the model during a turn. A port the run
// implements and the model port's adapters call: the adapter mounts each
// group as its own server or tool set and never reads a tool's meaning.
// Built once per open or fork; a group's catalog may change between calls.

/** Value. The provider's id for one tool call within a turn. */
export type ToolUseId = string;

/** The groups Rome serves tools in. */
export type RomeToolGroup = "actions" | "subagents" | "skills" | "ask_user";

export interface ModelToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
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
  /**
   * Whether the ask-user tool parks the turn on a card someone will answer.
   * An adapter whose model has a terminal question tool of its own turns
   * that tool off when this is true. Not derivable from the catalog: a
   * detached fork advertises the same tools and answers in prose.
   */
  readonly asksOnCard: boolean;
}
