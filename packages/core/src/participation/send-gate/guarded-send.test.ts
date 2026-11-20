import { describe, expect, it } from "@rstest/core";
import type { SendRequest } from "./index.js";
import { guardedSend } from "./index.js";

function request(
  recipient: SendRequest["recipient"],
  destination: SendRequest["destination"] = {
    place: "direct",
    sameChatAsWake: true,
    onlyGuardianReads: recipient?.bondLevel === "guardian",
  },
): SendRequest {
  return {
    destination,
    recipient,
    author: { agentName: "main" },
  };
}

describe("guardedSend", () => {
  it.each([
    { recipient: { bondLevel: "guardian" as const }, decision: "send" },
    { recipient: { bondLevel: "inner-circle" as const }, decision: "check" },
    { recipient: { bondLevel: "acquaintance" as const }, decision: "check" },
    { recipient: { bondLevel: "other" as const }, decision: "check" },
    { recipient: null, decision: "check" },
  ])("a message to $recipient → $decision", ({ recipient, decision }) => {
    expect(guardedSend(request(recipient))).toBe(decision);
  });

  // Today's rule and a known gap: others in the group read the reply, and
  // nobody checks it. Whether it should be checked is the guardian's call.
  it("sends a reply to the guardian's message in a group unchecked", () => {
    const destination = { place: "group" as const, sameChatAsWake: true, onlyGuardianReads: false };
    expect(guardedSend(request({ bondLevel: "guardian" }, destination))).toBe("send");
  });
});
