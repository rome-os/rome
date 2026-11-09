import { describe, expect, it } from "@rstest/core";
import { askQuestionToolOutput, parseAskQuestionInput, type Question } from "./ask-question.js";

const single = (options: unknown) => ({
  questions: [{ id: "q1", question: "Pick one", type: "single", options }],
});

const multi = (options: unknown) => ({
  questions: [{ id: "q1", question: "Pick any", type: "multi", options }],
});

const QUESTIONS = {
  questions: [
    { id: "weekend", question: "Which weekend?", type: "single", options: ["This", "Next"] },
    { id: "city", question: "Which city?", type: "text" },
  ],
};

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

  it("passes defaults, text and descriptions through without changing the questions", () => {
    const input = {
      questions: [
        {
          id: "one",
          question: "Pick one",
          type: "single",
          options: ["A", "B"],
          defaults: ["B"],
          optionDescriptions: { A: "First", B: "Second" },
        },
        {
          id: "many",
          question: "Pick any",
          type: "multi",
          options: ["A", "B"],
          defaults: ["A", "B"],
        },
        { id: "none", question: "Pick any", type: "multi", options: ["A"], defaults: [] },
        { id: "text", question: "Anything else?", type: "text", defaultText: "Billing only" },
        { id: "empty", question: "Anything else?", type: "text", defaultText: "" },
      ],
    };
    expect(parseAskQuestionInput(input)).toEqual({ ok: true, questions: input.questions });
  });

  it("leaves questions without the new fields byte-for-byte unchanged", () => {
    const result = parseAskQuestionInput(QUESTIONS);
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(JSON.stringify(result.questions)).toBe(JSON.stringify(QUESTIONS.questions));
  });

  it.each([
    ["single", { defaults: ["Unknown"] }, "defaults"],
    ["multi", { defaults: ["Unknown"] }, "defaults"],
    ["single", { defaults: ["A", "B"] }, "defaults"],
    ["multi", { defaults: "A" }, "defaults"],
    ["multi", { defaults: [42] }, "defaults"],
    ["single", { defaults: null }, "defaults"],
    ["text", { defaults: [] }, "defaults"],
    ["single", { defaultText: "A" }, "defaultText"],
    ["text", { defaultText: 42 }, "defaultText"],
    ["text", { defaultText: null }, "defaultText"],
    ["single", { optionDescriptions: { Unknown: "Not an option" } }, "optionDescriptions"],
    ["multi", { optionDescriptions: { A: 42 } }, "optionDescriptions"],
    ["multi", { optionDescriptions: [] }, "optionDescriptions"],
    ["multi", { optionDescriptions: null }, "optionDescriptions"],
    ["single", { optionDescriptions: "First" }, "optionDescriptions"],
    ["text", { optionDescriptions: {} }, "optionDescriptions"],
  ])("rejects malformed %s fields %j", (type, fields, field) => {
    const result = parseAskQuestionInput({
      questions: [{ id: "q1", question: "Pick", type, options: ["A", "B"], ...fields }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(`questions[0].${field}`);
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

  it("keeps defaults and descriptions in the card and the plain message", () => {
    const questions: Question[] = [
      {
        id: "many",
        question: "Which events?",
        type: "multi",
        options: ["Reviews", "Issues"],
        defaults: ["Reviews"],
        optionDescriptions: { Reviews: "Requests for review.", Issues: "New issues." },
      },
      {
        id: "one",
        question: "Which scope?",
        type: "single",
        options: ["Mine", "All"],
        defaults: ["Mine"],
      },
      {
        id: "note",
        question: "Anything else?",
        type: "text",
        defaultText: "Billing only",
        optional: true,
      },
      { id: "people", question: "Ignore whom?", type: "text", defaultText: "", optional: true },
    ];
    expect(askQuestionToolOutput(questions, true)).toMatchObject({
      render: { props: { questions } },
    });
    expect(askQuestionToolOutput(questions, false)).toBe(
      "This surface cannot render an interactive UI. Ask the guardian the " +
        "following as a plain message, then wait for their reply before doing " +
        "anything else:\n\nWhich events? (pick any that apply)\n- Reviews (default) — Requests for review.\n- Issues — New issues.\n\nWhich scope?\n- Mine (default)\n- All\n\nAnything else? (optional)\nDefault: Billing only\n\nIgnore whom? (optional)\nDefault: (empty)",
    );
  });

  it("relays the questions as a plain message otherwise", () => {
    const output = askQuestionToolOutput(questions, false);

    expect(output).toContain("Ask the guardian the following as a plain message");
    expect(output).toContain("Which day?\n- Mon\n- Tue\n- (or describe your own)");
    expect(output).toContain("Anything else? (optional)");
  });
});
