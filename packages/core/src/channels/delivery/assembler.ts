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
 *   still open.
 * - A `text` completes its block and its content replaces whatever the
 *   deltas built, since the complete block is authoritative.
 * - A `result` adds the answer as a last block unless a block already carries
 *   exactly that text, so a final answer is never sent twice.
 */
export class ReplyAssembler {
  readonly blocks: TextBlock[] = [];
  private readonly byId = new Map<string, TextBlock>();
  private open?: TextBlock;

  /** Applies `event` and answers how much the reply's text grew (negative
   *  when a complete block came out shorter than its deltas). */
  apply(event: StreamAgentEvent): number {
    if (event.type === "text_delta") {
      const block = this.blockFor(event.blockId);
      if (block.complete) return 0;
      block.text += event.content;
      return event.content.length;
    }
    if (event.type === "text") {
      const block = this.blockFor(event.blockId);
      const grew = event.content.length - block.text.length;
      block.text = event.content;
      block.complete = true;
      if (block === this.open) this.open = undefined;
      return grew;
    }
    if (event.type === "result") {
      const answer = event.content;
      if (!answer || this.blocks.some((block) => block.text === answer)) return 0;
      this.blocks.push({ text: answer, complete: true });
      return answer.length;
    }
    return 0;
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
