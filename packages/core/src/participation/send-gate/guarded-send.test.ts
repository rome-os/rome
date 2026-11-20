import { describe, expect, it } from "@rstest/core";
import type { SendRequest } from "./index.js";
import { guardedSend } from "./index.js";

function request(recipient: SendRequest["recipient"]): SendRequest {
  return {
    destination: { connectionId: "connection:telegram", chatId: "chat-1" },
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
});
