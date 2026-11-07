import { describe, expect, it } from "@rstest/core";
import { askQuestionToolOutput, normalizeAskQuestionForCard } from "./ask-question.js";

const single = (options: unknown) => ({
  questions: [{ id: "q1", question: "Pick one", type: "single", options }],
});

const multi = (options: unknown) => ({
  questions: [{ id: "q1", question: "Pick any", type: "multi", options }],
});

describe("normalizeAskQuestionForCard", () => {
  it("accepts well-formed single-choice and text questions", () => {
    const result = normalizeAskQuestionForCard({
      questions: [
        { id: "q1", question: "Pick one", type: "single", options: ["A", "B"] },
        { id: "q2", question: "Anything else?", type: "text" },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("accepts a well-formed multi-choice question", () => {
    expect(normalizeAskQuestionForCard(multi(["A", "B", "C"])).ok).toBe(true);
  });

  it("rejects a non-object input", () => {
    expect(normalizeAskQuestionForCard("nope").ok).toBe(false);
    expect(normalizeAskQuestionForCard({ questions: [] }).ok).toBe(false);
  });

  it("rejects missing id / question / type", () => {
    expect(normalizeAskQuestionForCard({ questions: [{ question: "x", type: "text" }] }).ok).toBe(
      false,
    );
    expect(normalizeAskQuestionForCard({ questions: [{ id: "q1", type: "text" }] }).ok).toBe(false);
    expect(
      normalizeAskQuestionForCard({ questions: [{ id: "q1", question: "x", type: "bogus" }] }).ok,
    ).toBe(false);
  });

  it("rejects single-choice with a missing or empty options array", () => {
    expect(normalizeAskQuestionForCard(single(undefined)).ok).toBe(false);
    expect(normalizeAskQuestionForCard(single([])).ok).toBe(false);
  });

  it("rejects multi-choice with a missing or empty options array", () => {
    expect(normalizeAskQuestionForCard(multi(undefined)).ok).toBe(false);
    expect(normalizeAskQuestionForCard(multi([])).ok).toBe(false);
  });

  // Regression: the web renderer drops non-string options, so these used to
  // pass and render a choice card with zero buttons (a dead parked turn).
  it("rejects single-choice options that are not all non-empty strings", () => {
    expect(normalizeAskQuestionForCard(single([null])).ok).toBe(false);
    expect(normalizeAskQuestionForCard(single(["", "B"])).ok).toBe(false);
    expect(normalizeAskQuestionForCard(single(["A", 42])).ok).toBe(false);
    expect(normalizeAskQuestionForCard(single(["  "])).ok).toBe(false);
  });

  it("rejects multi-choice options that are not all non-empty strings", () => {
    expect(normalizeAskQuestionForCard(multi([null])).ok).toBe(false);
    expect(normalizeAskQuestionForCard(multi(["A", 42])).ok).toBe(false);
  });
});

describe("askQuestionToolOutput", () => {
  const questions = [
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
