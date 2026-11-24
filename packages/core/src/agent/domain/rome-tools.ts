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
export const ROME_TOOL_GROUPS = ["actions", "subagents", "skills", "ask_user", "computer"] as const;

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

export interface RomeToolText {
  type: "text";
  text: string;
}

export interface RomeToolImage {
  type: "image";
  mimeType: "image/png" | "image/jpeg";
  data: string;
}

export type RomeToolContent = RomeToolText | RomeToolImage;

/** Image results start with text metadata so existing text callers retain their first block. */
export interface RomeToolResult {
  content: RomeToolText[] | [RomeToolText, ...RomeToolContent[]];
  isError?: boolean;
  /** The model receives the result, but Rome's activity trace omits its private contents. */
  redactFromTrace?: boolean;
}

/** Image bytes belong to model input, never the persisted activity trace. */
export function romeToolTraceOutput(result: RomeToolResult): RomeToolResult {
  return {
    content: result.redactFromTrace
      ? [{ type: "text", text: "Private computer-use result omitted from activity." }]
      : result.content.map((item) =>
          item.type === "text"
            ? item
            : { type: "text", text: `[${item.mimeType} image omitted from activity]` },
        ),
    ...(result.isError === undefined ? {} : { isError: result.isError }),
  };
}

export type RomeToolHandler = (
  input: Record<string, unknown>,
  context?: ModelToolCallContext,
) => Promise<RomeToolResult>;

/** A Rome tool with the handler that runs it. */
export interface RomeTool extends RomeToolDefinition {
  handler: RomeToolHandler;
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
