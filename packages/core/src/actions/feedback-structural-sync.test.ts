import { describe, expect, it } from "@rstest/core";
import {
  type AgentFeedback as CoreInput,
  type FeedbackOutcome as CoreOutcome,
  feedbackInputSchema as coreSchema,
} from "../lib/feedback-client.js";
import {
  type AgentFeedback as ActionInput,
  type FeedbackOutcome as ActionOutcome,
  feedbackInputSchema as actionSchema,
} from "../../../../rome_apps/system/src/actions/send-feedback/index.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
const inputInSync: Equal<CoreInput, ActionInput> = true;
const outcomeInSync: Equal<CoreOutcome, ActionOutcome> = true;

const base = { category: "bug", summary: "Broken", details: "Repro" };

describe("feedback structural contracts", () => {
  it("matches core and action (enforced by typecheck)", () => {
    expect(inputInSync && outcomeInSync).toBe(true);
  });

  // Types cannot see length/format rules; run boundary inputs through both.
  it.each([
    base,
    { ...base, category: "other" },
    { ...base, category: "invalid" },
    { ...base, summary: "" },
    { ...base, summary: " " },
    { ...base, summary: "x".repeat(160) },
    { ...base, summary: "x".repeat(161) },
    { ...base, summary: "two\nlines" },
    { ...base, summary: "two lines" },
    { ...base, subject: "x".repeat(200) },
    { ...base, subject: "x".repeat(201) },
    { ...base, summary: "x", details: "x".repeat(3997) },
    { ...base, summary: "x", details: "x".repeat(3998) },
    { ...base, unknown: true },
  ])("core and action agree on %j", (input) => {
    expect(actionSchema.safeParse(input).success).toBe(coreSchema.safeParse(input).success);
  });
});
