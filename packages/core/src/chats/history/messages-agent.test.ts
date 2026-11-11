import { describe, expect, it } from "@rstest/core";
import { widgetText } from "../widget-text.js";
import { messageContentText } from "./messages-agent.js";

describe("messageContentText", () => {
  it("reads a dashboard answer without the narration that led to it", () => {
    const content = JSON.stringify([
      { type: "text", content: "Checking the fares.", turnPhase: "commentary" },
      { type: "task_chat", chatId: "task-1", title: "Flights" },
      { type: "text", content: "3 options", turnPhase: "final" },
    ]);

    expect(messageContentText(content)).toBe("3 options");
  });

  it("reads a Concierge start message as its acknowledgement, without the quote or the card", () => {
    const content = JSON.stringify([
      { type: "reply_to", messageId: "g1", author: "guardian", text: "research X" },
      { type: "text", content: "On it: X" },
      { type: "task_chat", chatId: "task-1", title: "Research X" },
    ]);

    expect(messageContentText(content)).toBe("On it: X");
  });

  it("reads a card as the plain-text line a text-only platform showed", () => {
    const card = {
      type: "approval_card",
      approvalId: "a-1",
      actionName: "deploy",
      preview: { kind: "generic", title: "Deploy", summary: "Ship it" },
      status: "approved",
    } as const;
    const content = JSON.stringify([{ type: "text", content: "Before I go on:" }, card]);

    expect(messageContentText(content)).toBe(`Before I go on:\n${widgetText(card)}`);
  });

  it("reads a card whose stored preview is malformed without losing the text beside it", () => {
    const content = JSON.stringify([
      { type: "text", content: "Before I go on:" },
      {
        type: "approval_card",
        approvalId: "a-1",
        actionName: "deploy",
        preview: { kind: "generic", title: "Deploy", fields: {} },
        status: "pending",
      },
      { type: "text", content: "Back soon." },
    ]);

    const text = messageContentText(content);
    expect(text?.startsWith("Before I go on:\nApproval needed: Deploy")).toBe(true);
    expect(text?.endsWith("Back soon.")).toBe(true);
  });
});
