import { describe, expect, it } from "@rstest/core";
import type { MessagePart } from "@rome-os/app-runtime";
import { partsText } from "./storage/message.js";
import { widgetText } from "./widget-text.js";

const card = (over: Partial<Extract<MessagePart, { type: "approval_card" }>> = {}) =>
  ({
    type: "approval_card",
    approvalId: "a-1",
    actionName: "send_email",
    preview: {
      kind: "generic",
      title: "Send an email",
      summary: "To Dana, about Friday",
      fields: [{ label: "Subject", value: "Lunch" }],
    },
    status: "pending",
    ...over,
  }) as MessagePart;

describe("widgetText", () => {
  it("reads a waiting approval card as what it asks and where to answer it", () => {
    expect(widgetText(card())).toBe(
      [
        "Approval needed: Send an email",
        "To Dana, about Friday",
        "Subject: Lunch",
        "The guardian approves or denies it on Rome's dashboard.",
      ].join("\n"),
    );
  });

  it("says how an answered card stands, and asks nothing more", () => {
    expect(widgetText(card({ status: "rejected" }))).toBe(
      "Denied: Send an email\nTo Dana, about Friday\nSubject: Lunch",
    );
  });

  it("reads a message the agent wants to send as that message and why", () => {
    const line = widgetText(
      card({
        actionName: "send_message",
        preview: {
          kind: "sensitive_message",
          channel: "telegram",
          threadId: "1",
          text: "See you at 6",
          reason: "It goes to another chat",
        },
      }),
    );
    expect(line).toBe(
      [
        "Approval needed: send this message",
        "See you at 6",
        "Why: It goes to another chat",
        "The guardian approves or denies it on Rome's dashboard.",
      ].join("\n"),
    );
  });

  it("has no line for text, a part with none, or a card with no preview", () => {
    expect(widgetText({ type: "text", content: "Hi" })).toBeUndefined();
    expect(widgetText({ type: "turn_recap", turnId: "t", content: "Recap" })).toBeUndefined();
    expect(widgetText(card({ preview: undefined as never }))).toBeUndefined();
  });

  it("reads a field an app's preview left out as nothing", () => {
    const partial = card({ preview: { kind: "generic", title: "Deploy" } as never });
    expect(widgetText(partial)).toBe(
      "Approval needed: Deploy\nThe guardian approves or denies it on Rome's dashboard.",
    );
  });

  it("reads an app's widget as the line it brought", () => {
    const widget: MessagePart = {
      type: "widget",
      toolUseId: "tu-1",
      appId: "meals",
      componentId: "today",
      text: "You ate twice today.",
    };
    expect(widgetText(widget)).toBe("You ate twice today.");
    expect(partsText([widget])).toBe("You ate twice today.");
  });

  it("is how a recorded card reads as plain text", () => {
    expect(partsText([{ type: "text", content: "Before I send it:" }, card()])).toBe(
      `Before I send it:\n${widgetText(card())}`,
    );
  });
});
