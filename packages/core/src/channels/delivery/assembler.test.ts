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
    expect(matched.blocks).toMatchObject([{ text: "Hello", complete: true }]);

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

  it("keeps a block id of one turn apart from the same id in the next", () => {
    // A block id is unique only within its turn, so two turns can reuse one.
    const assembler = new ReplyAssembler();
    assembler.apply({ type: "turn_start", turnId: "t1", sessionId: "s", userPrompt: "" });
    assembler.apply(text("First turn.", "0", "final"));
    assembler.apply({ type: "turn_start", turnId: "t2", sessionId: "s", userPrompt: "" });
    assembler.apply({ type: "text_delta", content: "Second", blockId: "0" });
    assembler.apply({ type: "result", content: "Second turn." });

    expect(blocksOf(assembler)).toEqual(["First turn.", "Second", "Second turn."]);
  });

  it("counts each time a block's text is replaced, and not each time it grows", () => {
    const assembler = new ReplyAssembler();
    assembler.apply({ type: "text_delta", content: "Hel", blockId: "a" });
    assembler.apply({ type: "text_delta", content: "lo", blockId: "a" });
    expect(assembler.blocks[0]!.revision).toBe(0);
    assembler.apply(text("Hello", "a"));
    expect(assembler.blocks[0]!.revision).toBe(1);
  });

  it("gives a block's text from any offset, across the deltas it grew by and after it is replaced", () => {
    const assembler = new ReplyAssembler();
    for (const piece of ["Hel", "lo ", "", "wor", "ld"])
      assembler.apply({ type: "text_delta", content: piece, blockId: "a" });
    const [block] = assembler.blocks;
    for (let start = 0; start <= 12; start++)
      expect(block!.from(start)).toBe("Hello world".slice(start));
    assembler.apply(text("Goodbye", "a"));
    expect(block!.from(4)).toBe("bye");
  });
});
