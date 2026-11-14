// The live sign that the agent is writing a message, the chat's typing dots
// (docs/domains/chats.md#status-reaction). A provider that streams a tool
// call's input says exactly when a message tool's call starts; for any other
// the clients show the dots briefly before each message lands.

import type { MessageWritingMode } from "@rome/api-types/concierge";

/** The tools whose call is itself a message the chat shows. */
const MESSAGE_TOOLS = new Set(["say", "chat_forward"]);

/** A tool's name without its provider or group prefix (`mcp__rome__say`, `core:say`). */
function bareTool(tool: string): string {
  const afterMcp = tool.includes("__") ? tool.slice(tool.lastIndexOf("__") + 2) : tool;
  return afterMcp.slice(afterMcp.lastIndexOf(":") + 1).toLowerCase();
}

/**
 * How a provider's turns show the typing dots: exactly where it streams a
 * call's input as it is written (Claude), simulated where it hands a call
 * over whole (Codex, and any provider not known to stream it).
 */
export function messageWritingModeOf(providerId: string | undefined): MessageWritingMode {
  return providerId === "anthropic" ? "exact" : "simulated";
}

/**
 * One turn's writing: whether a message call is being written now. Only an
 * exact turn ever writes; a simulated one stays false, and its clients hold
 * each message behind the dots for a moment instead.
 */
export class MessageWriting {
  /** The message calls whose input is streaming and that have not landed whole. */
  private readonly open = new Set<string>();
  private readonly landed = new Set<string>();

  constructor(public mode: MessageWritingMode) {}

  get writing(): boolean {
    return this.open.size > 0;
  }

  /**
   * Takes the turn's next event. Answers the writing state when it changed:
   * true from the first input of a message call, false once the call lands
   * whole or the turn ends; null when it did not change.
   */
  on(msg: { type: string; tool?: string; toolUseId?: string; id?: string }): boolean | null {
    if (this.mode !== "exact") return null;
    const before = this.writing;
    if (msg.type === "tool_input_delta" && msg.toolUseId && msg.tool) {
      if (!MESSAGE_TOOLS.has(bareTool(msg.tool)) || this.landed.has(msg.toolUseId)) return null;
      this.open.add(msg.toolUseId);
    } else if (msg.type === "tool_use" && msg.id) {
      this.landed.add(msg.id);
      this.open.delete(msg.id);
    } else if (msg.type === "result" || msg.type === "error") {
      this.open.clear();
    } else {
      return null;
    }
    return this.writing === before ? null : this.writing;
  }
}
