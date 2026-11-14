import { describe, expect, it } from "@rstest/core";
import {
  CONCLUSION_CLOSE,
  CONCLUSION_MAX_CHARS,
  CONCLUSION_OPEN,
  CONCLUSION_INSTRUCTION,
  NOTHING_TO_REPORT,
  RECURRING_PREFIX,
  recurringOf,
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
    expect(CONCLUSION_INSTRUCTION).toContain(CONCLUSION_OPEN);
    expect(CONCLUSION_INSTRUCTION).toContain(CONCLUSION_CLOSE);
    // The result reaches the guardian through the Concierge, never by a send of the task chat's own.
    expect(CONCLUSION_INSTRUCTION).toContain(
      "Never send a message into the guardian's Concierge chat yourself",
    );
    expect(CONCLUSION_INSTRUCTION).toContain(`${CONCLUSION_MAX_CHARS} characters`);
    expect(CONCLUSION_INSTRUCTION).toContain("in every final answer");
    expect(CONCLUSION_INSTRUCTION).toContain("when the guardian writes to you directly");
    expect(CONCLUSION_INSTRUCTION).toContain("Never put a secret");
  });

  it("gives a result that only carries out the guardian's own choice the fixed no-news line", () => {
    expect(CONCLUSION_INSTRUCTION).toContain("only confirms or carries out what they just chose");
    expect(CONCLUSION_INSTRUCTION).toContain(`exactly "${NOTHING_TO_REPORT}", word for word`);
  });

  it("leaves recurring work to the Concierge's schedule, and keeps the task's own checks", () => {
    expect(CONCLUSION_INSTRUCTION).toContain("set up no routine or schedule yourself");
    expect(CONCLUSION_INSTRUCTION).toContain(`starting with "${RECURRING_PREFIX}"`);
    expect(CONCLUSION_INSTRUCTION).toContain("Keep it out of the conclusion");
    expect(CONCLUSION_INSTRUCTION).toContain(
      "Checks you defer while you work on the task are yours",
    );
  });

  it("reads the recurring line outside the conclusion only", () => {
    const answer = `Here is today's quote.\n${RECURRING_PREFIX} every day at 10:00\n\n${CONCLUSION_OPEN}\nA quote.\n${CONCLUSION_CLOSE}`;
    expect(recurringOf(answer)).toBe("every day at 10:00");
    expect(
      recurringOf(`${CONCLUSION_OPEN}\n${RECURRING_PREFIX} daily\n${CONCLUSION_CLOSE}`),
    ).toBeNull();
    expect(recurringOf("No wish here.")).toBeNull();
  });

  it("follows the language of the guardian's request as the brief gives it, and names no other", () => {
    expect(CONCLUSION_INSTRUCTION).toContain(
      "written in the language of the guardian's request as your brief gives it",
    );
    expect(CONCLUSION_INSTRUCTION).not.toMatch(/English|Chinese|dashboard/);
  });
});

describe("taskChatInstructions", () => {
  const chats = new Map([
    ["task-1", { triggerKind: "concierge" }],
    ["plain-1", { triggerKind: null }],
  ]);
  const instructions = taskChatInstructions({
    webchatRepo: { getSession: async (id: string) => chats.get(id) ?? null },
  } as never);
  const webchat = (threadId: string) => ({ channel: "webchat", threadId });

  it("answers the instruction for a task chat only", async () => {
    expect(await instructions(webchat("task-1") as never)).toBe(CONCLUSION_INSTRUCTION);
    expect(await instructions(webchat("plain-1") as never)).toBeNull();
    expect(await instructions(webchat("missing") as never)).toBeNull();
    expect(await instructions({ channel: "telegram", threadId: "task-1" } as never)).toBeNull();
    expect(await instructions(undefined)).toBeNull();
  });
});
