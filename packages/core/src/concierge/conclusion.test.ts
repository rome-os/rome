import { describe, expect, it } from "@rstest/core";
import {
  CONCLUSION_CLOSE,
  CONCLUSION_INSTRUCTION,
  CONCLUSION_MAX_CHARS,
  CONCLUSION_OPEN,
  conclusionOf,
  withoutConclusion,
  withoutMarkers,
} from "./conclusion.js";

const answer = (conclusion: string) =>
  `The full report.\n\nWith a table.\n\n${CONCLUSION_OPEN}\n${conclusion}\n${CONCLUSION_CLOSE}`;

describe("conclusionOf", () => {
  it("finds the section between the markers, trimmed", () => {
    expect(conclusionOf(answer("Found 3 flights. Which one?"))).toEqual({
      kind: "found",
      text: "Found 3 flights. Which one?",
    });
  });

  it("takes the last section when an answer quotes an earlier one", () => {
    const text = `${answer("Old.")}\n\nMore work.\n\n${answer("New.")}`;
    expect(conclusionOf(text)).toEqual({ kind: "found", text: "New." });
  });

  it("forgives spaces in the markers and a missing closing marker", () => {
    expect(
      conclusionOf("Details.\n\n<!--rome:conclusion-->Done.\n<!--  /rome:conclusion  -->"),
    ).toEqual({
      kind: "found",
      text: "Done.",
    });
    expect(conclusionOf(`Details.\n\n${CONCLUSION_OPEN}\nDone, nothing else.`)).toEqual({
      kind: "found",
      text: "Done, nothing else.",
    });
  });

  it("answers missing for no section, an empty one, and a closing marker alone", () => {
    expect(conclusionOf("Just details.")).toEqual({ kind: "missing" });
    expect(conclusionOf(answer("  \n "))).toEqual({ kind: "missing" });
    expect(conclusionOf(`Details.\n${CONCLUSION_CLOSE}`)).toEqual({ kind: "missing" });
  });

  it("refuses a section over the cap without cutting it, counting characters, not bytes", () => {
    expect(conclusionOf(answer("x".repeat(CONCLUSION_MAX_CHARS)))).toMatchObject({ kind: "found" });
    expect(conclusionOf(answer("x".repeat(CONCLUSION_MAX_CHARS + 1)))).toEqual({
      kind: "too_long",
      length: CONCLUSION_MAX_CHARS + 1,
    });
    // 600 Chinese characters and 600 emoji are 600 characters.
    expect(conclusionOf(answer("结".repeat(CONCLUSION_MAX_CHARS)))).toMatchObject({
      kind: "found",
    });
    expect(conclusionOf(answer("👩‍👩‍👧".repeat(CONCLUSION_MAX_CHARS)))).toMatchObject({
      kind: "found",
    });
  });
});

describe("withoutMarkers and withoutConclusion", () => {
  it("leaves the conclusion's text in place without its markers", () => {
    const text = withoutMarkers(answer("Done."));
    expect(text).toBe("The full report.\n\nWith a table.\n\nDone.");
    expect(text).not.toContain("rome:conclusion");
  });

  it("drops the whole section, markers and text", () => {
    expect(withoutConclusion(answer("Done."))).toBe("The full report.\n\nWith a table.");
    expect(withoutConclusion(`${answer("Done.")}\n\nAfterwards.`)).toBe(
      "The full report.\n\nWith a table.\n\nAfterwards.",
    );
    expect(withoutConclusion("No section.")).toBe("No section.");
  });
});

describe("the instruction every task chat gets", () => {
  it("names both markers, the cap, and every turn", () => {
    expect(CONCLUSION_INSTRUCTION).toContain(CONCLUSION_OPEN);
    expect(CONCLUSION_INSTRUCTION).toContain(CONCLUSION_CLOSE);
    expect(CONCLUSION_INSTRUCTION).toContain(`${CONCLUSION_MAX_CHARS} characters`);
    expect(CONCLUSION_INSTRUCTION).toContain("in every final answer");
    expect(CONCLUSION_INSTRUCTION).toContain("when the guardian writes to you directly");
    expect(CONCLUSION_INSTRUCTION).toContain("Never put a secret");
  });
});
