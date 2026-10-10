import type { StreamAgentEvent } from "@rome-os/app-runtime";

/** One piece of reply text the agent produced: a commentary, or the answer. */
export interface TextBlock {
  text: string;
  /** The agent finished the block, so its text will not change again. */
  complete: boolean;
}

/**
 * Builds the text a run's reply is made of from the run's events, in the
 * order the blocks began. Only assistant text counts: thinking, tool calls and
 * any other event leave the reply unchanged. Event contract:
 * docs/concepts/sessions.md (Event, Block, Delta).
 *
 * - A `text_delta` grows its block, matched by `blockId`, or else the block
 *   still open. A provider gives a block's deltas and its text one id, or
 *   neither, and an event with an id is not taken to be part of a block that
 *   has none, since that could join two different blocks.
 * - A `text` completes its block and its content replaces whatever the
 *   deltas built, since the complete block is authoritative.
 * - A `result` adds the answer as a last block, unless the provider already
 *   sent the answer as a text block marked `final`, or a block carries exactly
 *   that text. The `result` repeats the answer, and the two may differ by
 *   whitespace, so the answer is never sent twice.
 */
export class ReplyAssembler {
  readonly blocks: TextBlock[] = [];
  private readonly byId = new Map<string, TextBlock>();
  private open?: TextBlock;
  /** A block the provider marked as the turn's final answer has completed. */
  private finalSeen = false;

  /** Applies `event` to the blocks. */
  apply(event: StreamAgentEvent): void {
    if (event.type === "text_delta") {
      const block = this.blockFor(event.blockId);
      if (!block.complete) block.text += event.content;
      return;
    }
    if (event.type === "text") {
      const block = this.blockFor(event.blockId);
      block.text = event.content;
      block.complete = true;
      if (event.turnPhase === "final") this.finalSeen = true;
      if (block === this.open) this.open = undefined;
      return;
    }
    if (event.type === "result") {
      const answer = event.content;
      // Once a text block marked `final` has arrived, the answer was streamed,
      // and the `result` would show it twice where the two differ by whitespace.
      // An agent that declares an output schema has a `result` of canonical JSON,
      // which may not be what streamed. Which of the two is authoritative is
      // decided where the engine is wired into runs.
      if (!answer || this.finalSeen || this.blocks.some((block) => block.text === answer)) return;
      this.blocks.push({ text: answer, complete: true });
    }
  }

  private blockFor(id: string | undefined): TextBlock {
    const known = id === undefined ? this.open : this.byId.get(id);
    if (known) return known;
    const block: TextBlock = { text: "", complete: false };
    this.blocks.push(block);
    if (id === undefined) this.open = block;
    else this.byId.set(id, block);
    return block;
  }
}
