import { describe, expect, it } from "@rstest/core";
import type {
  AgentFeedback as CoreInput,
  FeedbackOutcome as CoreOutcome,
} from "../lib/feedback-client.js";
import type {
  AgentFeedback as ActionInput,
  FeedbackOutcome as ActionOutcome,
} from "../../../../rome_apps/system/src/actions/send-feedback/index.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
const inputInSync: Equal<CoreInput, ActionInput> = true;
const outcomeInSync: Equal<CoreOutcome, ActionOutcome> = true;

describe("feedback structural contracts", () => {
  it("matches core and action (enforced by typecheck)", () => {
    expect(inputInSync && outcomeInSync).toBe(true);
  });
});
