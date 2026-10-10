import { describe, expect, it } from "@rstest/core";
import { ReplyAssembler } from "./assembler.js";

const text = (content: string, blockId: string, turnPhase?: "commentary" | "final") =>
  ({ type: "text", content, blockId, ...(turnPhase ? { turnPhase } : {}) }) as const;

const blocksOf = (assembler: ReplyAssembler) => assembler.blocks.map((block) => block.text);

describe("ReplyAssembler", () => {
  it("matches a block's deltas to its text by id, and does not guess when only one side has an id", () => {
    const matched = new ReplyAssembler();
    matched.apply({ type: "text_delta", content: "Hel", blockId: "a" });
    matched.apply({ type: "text_delta", content: "lo", blockId: "a" });
    matched.apply({ type: "text", content: "Hello", blockId: "a" });
    expect(matched.blocks).toEqual([{ text: "Hello", complete: true }]);

    // A provider gives a block's deltas and its text one id, or neither. Merging a block
    // that has an id into one that has none could join two different blocks, so they stay apart.
    const mixed = new ReplyAssembler();
    mixed.apply({ type: "text_delta", content: "Hi", blockId: "a" });
    mixed.apply({ type: "text", content: "Hi" });
    expect(mixed.blocks).toHaveLength(2);
  });

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
