import { describe, expect, it } from "@rstest/core";
import { ReplyAssembler } from "./assembler.js";

const text = (content: string, blockId: string, turnPhase?: "commentary" | "final") =>
  ({ type: "text", content, blockId, ...(turnPhase ? { turnPhase } : {}) }) as const;

const blocksOf = (assembler: ReplyAssembler) => assembler.blocks.map((block) => block.text);

describe("ReplyAssembler", () => {
  it("does not add a result that repeats a block exactly", () => {
    const assembler = new ReplyAssembler();
    assembler.apply(text("The answer is 42.", "a"));
    assembler.apply({ type: "result", content: "The answer is 42." });

    expect(blocksOf(assembler)).toEqual(["The answer is 42."]);
  });

  it("does not add a result when the final answer already arrived as a text block, even if the two differ", () => {
    const assembler = new ReplyAssembler();
    assembler.apply(text("Let me check.", "c", "commentary"));
    // The provider's result is trimmed, and its final block is not.
    assembler.apply(text("The answer is 42.\n", "a", "final"));
    assembler.apply({ type: "result", content: "The answer is 42." });

    expect(blocksOf(assembler)).toEqual(["Let me check.", "The answer is 42.\n"]);
  });

  it("adds the result when no text block carried the final answer", () => {
    const assembler = new ReplyAssembler();
    assembler.apply(text("Let me check.", "c", "commentary"));
    assembler.apply({ type: "result", content: "The answer is 42." });

    expect(blocksOf(assembler)).toEqual(["Let me check.", "The answer is 42."]);
  });

  it("adds the result when the answer came only as deltas", () => {
    const assembler = new ReplyAssembler();
    assembler.apply({ type: "text_delta", content: "The answer", blockId: "a" });
    assembler.apply({ type: "result", content: "The answer is 42." });

    expect(blocksOf(assembler)).toEqual(["The answer", "The answer is 42."]);
  });
});
