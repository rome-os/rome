export interface AssistantTextBlock {
  blockIx: number;
  content: string;
  turnPhase?: "commentary" | "final";
}

/** Pure text state. Transport, trace persistence and interruption policy belong to callers. */
export class AssistantTextAssembler {
  blockIx = 0;
  pending = "";
  lastCompleted?: AssistantTextBlock;
  private finalBlockIx?: number;
  private finalContent = "";
  private readonly identified = new Map<string, { blockIx: number; content: string }>();
  private nextIdentityIx = 0;

  append(content: string, blockId?: string): AssistantTextBlock {
    if (blockId) {
      const block = this.identified.get(blockId) ?? {
        blockIx: Math.max(this.blockIx, this.nextIdentityIx++),
        content: "",
      };
      this.nextIdentityIx = Math.max(this.nextIdentityIx, block.blockIx + 1);
      block.content += content;
      this.identified.set(blockId, block);
      return { ...block };
    }
    this.pending += content;
    return { blockIx: this.blockIx, content: this.pending };
  }

  complete(
    content: string,
    turnPhase?: AssistantTextBlock["turnPhase"],
    blockId?: string,
  ): AssistantTextBlock {
    const blockIx = blockId
      ? (this.identified.get(blockId)?.blockIx ?? Math.max(this.blockIx, this.nextIdentityIx++))
      : this.blockIx;
    const block = { blockIx, content, turnPhase };
    if (blockId) this.identified.set(blockId, block);
    this.lastCompleted = block;
    if (turnPhase === "final") {
      this.finalBlockIx = block.blockIx;
      this.finalContent = content;
    }
    this.blockIx = Math.max(this.blockIx, blockIx + 1);
    this.pending = "";
    return block;
  }

  final(content: string): AssistantTextBlock {
    const last = this.lastCompleted;
    const resolved = content || this.finalContent;
    const reusable = last?.turnPhase === undefined && last?.content === resolved;
    return {
      blockIx: this.finalBlockIx ?? (reusable ? last!.blockIx : this.blockIx),
      content: resolved,
      turnPhase: "final",
    };
  }
}
