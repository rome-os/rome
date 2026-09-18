import { describe, expect, it } from "@rstest/core";
import { AssistantTextAssembler } from "./assistant-text.js";

describe("AssistantTextAssembler", () => {
  it("keeps interleaved provider blocks stable when completion arrives out of order", () => {
    const text = new AssistantTextAssembler();
    expect(text.append("a", "first").blockIx).toBe(0);
    expect(text.append("b", "second").blockIx).toBe(1);
    expect(text.append("c", "first")).toEqual({ blockIx: 0, content: "ac" });
    text.complete("answer", "final", "second");
    text.complete("commentary", "commentary", "first");
    expect(text.final("revised")).toEqual({ blockIx: 1, content: "revised", turnPhase: "final" });
    expect(text.append("d", "third").blockIx).toBe(2);
  });
  it("corrects complete blocks and retains commentary identity separately from the final", () => {
    const text = new AssistantTextAssembler();
    expect(text.append("par")).toEqual({ blockIx: 0, content: "par" });
    expect(text.complete("corrected", "commentary")).toEqual({
      blockIx: 0,
      content: "corrected",
      turnPhase: "commentary",
    });
    expect(text.append("answer")).toEqual({ blockIx: 1, content: "answer" });
    text.complete("answer", "final");
    expect(text.final("revised")).toEqual({ blockIx: 1, content: "revised", turnPhase: "final" });
    expect(text.final("").content).toBe("answer");
  });

  it("reuses matching unclassified text but never promotes commentary to final", () => {
    const text = new AssistantTextAssembler();
    text.complete("answer");
    expect(text.final("answer").blockIx).toBe(0);
    text.complete("commentary", "commentary");
    expect(text.final("").content).toBe("");
    expect(text.final("commentary").blockIx).toBe(2);
  });
});
