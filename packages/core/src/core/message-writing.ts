// The live sign that the agent is writing a message, the chat's typing dots
// (docs/domains/chats.md#reaction), and a connected chat's typing indicator.
// A provider that streams a tool call's input says exactly when a message
// tool's call starts; for any other the clients show the dots briefly before
// each message lands. Where the turn's text is its message, as on a
// connection, streaming that text is writing it.

import type { MessageWritingMode } from "@rome/api-types/concierge";
import { bareTool } from "../lib/tool-name.js";

/** The tools whose call is itself a message the chat shows. */
const MESSAGE_TOOLS = new Set(["say"]);
/** The open entry of a text block being written, where text is the message. */
const TEXT = "text";

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

  /**
   * `textIsMessage`: the turn's text is the message it sends, as on a
   * connection, where the reply is the turn's text: a text block streaming is
   * a message being written, until the block lands or a tool is called.
   */
  constructor(
    public mode: MessageWritingMode,
    private readonly options: { textIsMessage?: boolean } = {},
  ) {}

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
    if (this.options.textIsMessage && msg.type === "text_delta") {
      this.open.add(TEXT);
    } else if (this.options.textIsMessage && msg.type === "text") {
      this.open.delete(TEXT);
    } else if (this.options.textIsMessage && msg.type === "tool_use") {
      // A tool call ends any text before it, which was not the reply.
      this.open.clear();
    } else if (msg.type === "tool_input_delta" && msg.toolUseId && msg.tool) {
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
