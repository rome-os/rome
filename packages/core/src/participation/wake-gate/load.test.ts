import { describe, expect, it } from "@rstest/core";
import type { ChatSettingsSnapshot } from "@rome-os/app-runtime";
import { chatRules } from "./index.js";

describe("chatRules", () => {
  // Core resolves each rule before the gate reads it (chat-settings/rules.ts),
  // so the gate applies what the snapshot says, offered or fixed.
  it("applies the rules the chat runs on", () => {
    const snapshot = {
      conversation: {} as ChatSettingsSnapshot["conversation"],
      supportedFields: ["session.reset"],
      effective: {
        enabled: false,
        activation: {
          mode: "all",
          botMessages: "mentions",
          whenOthersMentioned: "respond",
          answers: "everyone",
        },
        replies: { placement: "thread" },
        routing: { agentName: null },
        session: { reset: { mode: "none" } },
      },
      overrides: {},
    } satisfies ChatSettingsSnapshot;
    expect(chatRules(snapshot)).toEqual({
      enabled: false,
      replyRule: "all",
      botMessages: "mentions",
      whenOthersMentioned: "respond",
      answers: "everyone",
    });
  });
});
