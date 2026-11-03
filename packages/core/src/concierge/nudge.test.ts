import { describe, expect, it } from "@rstest/core";
import { quotaRecoveryPrompt, shouldNudge } from "./nudge.js";

const base = { status: "completed" as const, text: "hi", reminderRunning: false };

describe("shouldNudge", () => {
  // Whether the turn spoke earlier does not matter: an ack bubble followed by
  // the answer as plain text still left the answer unsent.
  it("reminds a completed turn whose final text is not the end-of-turn marker", () => {
    expect(shouldNudge(base)).toBe(true);
  });

  it("leaves the marker, silence, interrupted turns, and running reminders alone", () => {
    expect(shouldNudge({ ...base, text: "  " })).toBe(false);
    expect(shouldNudge({ ...base, text: "Done." })).toBe(false);
    expect(shouldNudge({ ...base, status: "interrupted" })).toBe(false);
    expect(shouldNudge({ ...base, reminderRunning: true })).toBe(false);
  });
});

it("carries first-thread recovery instructions without relying on continuation", () => {
  const prompt = quotaRecoveryPrompt("Claude");
  for (const text of [
    "Claude ran out of quota",
    "system:fetch_channel_history",
    "limit 20",
    "this thread's channel and id",
    "task_list",
    "chat_list",
    "actual state",
    "verify",
    "Do only what remains",
    "ask the guardian rather than redo",
    "say",
    "done",
  ])
    expect(prompt).toContain(text);
});
