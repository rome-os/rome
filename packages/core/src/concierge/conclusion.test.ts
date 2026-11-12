import { describe, expect, it } from "@rstest/core";
import {
  CONCLUSION_CLOSE,
  CONCLUSION_MAX_CHARS,
  CONCLUSION_OPEN,
  conclusionInstruction,
  conclusionOf,
  taskChatInstructions,
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

  it("removes the markers of a one-line section and keeps its text", () => {
    expect(withoutMarkers(`Details.\n\n${CONCLUSION_OPEN}Done.${CONCLUSION_CLOSE}`)).toBe(
      "Details.\n\nDone.",
    );
  });

  it("returns an answer with no markers byte for byte", () => {
    const plain = "  Leading spaces.\n\n\n\nFour newlines.\n\n\n  \ttrailing  \n\n";
    expect(withoutMarkers(plain)).toBe(plain);
  });

  it("changes nothing but the markers and the lines they leave empty, code blocks included", () => {
    const code = "```py\nx = 1\n\n\n\ny = 2\n```";
    const text = `Intro.\n\n\n\n${code}\n\n${CONCLUSION_OPEN}\nDone.\n${CONCLUSION_CLOSE}\n`;
    expect(withoutMarkers(text)).toBe(`Intro.\n\n\n\n${code}\n\nDone.\n`);
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
    const text = conclusionInstruction("en");
    expect(text).toContain(CONCLUSION_OPEN);
    expect(text).toContain(CONCLUSION_CLOSE);
    expect(text).toContain(`${CONCLUSION_MAX_CHARS} characters`);
    expect(text).toContain("in every final answer");
    expect(text).toContain("when the guardian writes to you directly");
    expect(text).toContain("Never put a secret");
  });

  it("names the guardian's language when it is known", () => {
    expect(conclusionInstruction("en")).toContain("in the guardian's language, English");
    expect(conclusionInstruction("zh-CN")).toContain("in the guardian's language, Chinese");
  });

  it("follows the language of the guardian's request in the brief when it is not known", () => {
    for (const unknown of [null, "", "not a language!"]) {
      const text = conclusionInstruction(unknown);
      expect(text).toContain("in the language of the guardian's own request in your brief");
      expect(text).not.toContain("the guardian's language,");
    }
  });
});

describe("taskChatInstructions", () => {
  const chats = new Map([
    ["task-1", { triggerKind: "concierge" }],
    ["plain-1", { triggerKind: null }],
  ]);
  const deps = (language: unknown) => ({
    webchatRepo: { getSession: async (id: string) => chats.get(id) ?? null },
    settingsRepo: { get: async () => language },
  });
  const webchat = (threadId: string) => ({ channel: "webchat", threadId });

  it("answers the instruction, in the guardian's language, for a task chat only", async () => {
    const instructions = taskChatInstructions(deps("zh-CN") as never);
    expect(await instructions(webchat("task-1") as never)).toBe(conclusionInstruction("zh-CN"));
    expect(await instructions(webchat("plain-1") as never)).toBeNull();
    expect(await instructions(webchat("missing") as never)).toBeNull();
    expect(await instructions({ channel: "telegram", threadId: "task-1" } as never)).toBeNull();
    expect(await instructions(undefined)).toBeNull();
  });

  it("falls back to the request's language when the guardian's is not stored", async () => {
    const instructions = taskChatInstructions(deps(undefined) as never);
    expect(await instructions(webchat("task-1") as never)).toBe(conclusionInstruction(null));
  });
});
