import { describe, expect, it } from "@rstest/core";
import { askQuestionToolOutput, parseAskQuestionInput, type Question } from "./ask-question.js";

const single = (options: unknown) => ({
  questions: [{ id: "q1", question: "Pick one", type: "single", options }],
});

const multi = (options: unknown) => ({
  questions: [{ id: "q1", question: "Pick any", type: "multi", options }],
});

describe("parseAskQuestionInput", () => {
  it("accepts well-formed single-choice and text questions", () => {
    const result = parseAskQuestionInput({
      questions: [
        { id: "q1", question: "Pick one", type: "single", options: ["A", "B"] },
        { id: "q2", question: "Anything else?", type: "text" },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("accepts a well-formed multi-choice question", () => {
    expect(parseAskQuestionInput(multi(["A", "B", "C"])).ok).toBe(true);
  });

  it("rejects a non-object input", () => {
    expect(parseAskQuestionInput("nope").ok).toBe(false);
    expect(parseAskQuestionInput({ questions: [] }).ok).toBe(false);
  });

  it("rejects missing id / question / type", () => {
    expect(parseAskQuestionInput({ questions: [{ question: "x", type: "text" }] }).ok).toBe(false);
    expect(parseAskQuestionInput({ questions: [{ id: "q1", type: "text" }] }).ok).toBe(false);
    expect(
      parseAskQuestionInput({ questions: [{ id: "q1", question: "x", type: "bogus" }] }).ok,
    ).toBe(false);
  });

  it("rejects single-choice with a missing or empty options array", () => {
    expect(parseAskQuestionInput(single(undefined)).ok).toBe(false);
    expect(parseAskQuestionInput(single([])).ok).toBe(false);
  });

  it("rejects multi-choice with a missing or empty options array", () => {
    expect(parseAskQuestionInput(multi(undefined)).ok).toBe(false);
    expect(parseAskQuestionInput(multi([])).ok).toBe(false);
  });

  // Regression: the web renderer drops non-string options, so these used to
  // pass and render a choice card with zero buttons (a dead parked turn).
  it("rejects single-choice options that are not all non-empty strings", () => {
    expect(parseAskQuestionInput(single([null])).ok).toBe(false);
    expect(parseAskQuestionInput(single(["", "B"])).ok).toBe(false);
    expect(parseAskQuestionInput(single(["A", 42])).ok).toBe(false);
    expect(parseAskQuestionInput(single(["  "])).ok).toBe(false);
  });

  it("rejects multi-choice options that are not all non-empty strings", () => {
    expect(parseAskQuestionInput(multi([null])).ok).toBe(false);
    expect(parseAskQuestionInput(multi(["A", 42])).ok).toBe(false);
  });
});

describe("askQuestionToolOutput", () => {
  const questions: Question[] = [
    { id: "day", question: "Which day?", type: "single", options: ["Mon", "Tue"], freeText: true },
    { id: "note", question: "Anything else?", type: "text", optional: true },
  ];

  it("parks on the host's question card where a widget shows", () => {
    expect(askQuestionToolOutput(questions, true)).toMatchObject({
      pendingInteraction: true,
      appId: "core",
      render: {
        kind: "inline",
        componentId: "question-card",
        props: { questions },
        builtin: true,
      },
    });
  });

  it("relays the questions as a plain message otherwise", () => {
    const output = askQuestionToolOutput(questions, false);

    expect(output).toContain("Ask the guardian the following as a plain message");
    expect(output).toContain("Which day?\n- Mon\n- Tue\n- (or describe your own)");
    expect(output).toContain("Anything else? (optional)");
  });
});
