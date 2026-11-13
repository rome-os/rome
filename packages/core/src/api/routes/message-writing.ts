// The live sign that the agent is writing a message: a provider that streams
// a tool call's input tells the chat when a message tool's call starts, before
// the call lands whole (docs/domains/chats.md#status-reaction).

/** The tools whose call is itself a message the chat shows. */
const MESSAGE_TOOLS = new Set(["say", "chat_forward"]);

/**
 * The call `msg` starts writing as a message, the first time a provider
 * streams its input: the chat then knows the agent is writing one, before the
 * call lands whole. Null for any other event, and for a call already told.
 */
export function messageWritingStart(
  msg: { type: string; tool?: string; toolUseId?: string },
  told: Set<string>,
): string | null {
  if (msg.type !== "tool_input_delta" || !msg.toolUseId || !msg.tool) return null;
  const afterMcp = msg.tool.includes("__")
    ? msg.tool.slice(msg.tool.lastIndexOf("__") + 2)
    : msg.tool;
  const name = afterMcp.slice(afterMcp.lastIndexOf(":") + 1).toLowerCase();
  if (!MESSAGE_TOOLS.has(name) || told.has(msg.toolUseId)) return null;
  told.add(msg.toolUseId);
  return msg.toolUseId;
}
