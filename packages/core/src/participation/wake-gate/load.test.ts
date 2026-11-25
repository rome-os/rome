import { describe, expect, it } from "@rstest/core";
import type { ChatId, ChatSettingsSnapshot } from "@rome-os/app-runtime";
import { chatRules, wakeGateLoader } from "./index.js";

describe("chatRules", () => {
  // Core resolves each rule before the gate reads it (chat-settings/rules.ts),
  // so the gate applies what the snapshot says, offered or fixed.
  it("applies the rules the chat runs on", () => {
    const snapshot = {
      conversation: {} as ChatSettingsSnapshot["conversation"],
      supportedFields: ["session.reset"],
      effective: {
        enabled: false,
        activation: { mode: "all", botMessages: "mentions", whenOthersMentioned: "respond" },
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
    });
  });
});

describe("wakeGateLoader", () => {
  const snapshot = {
    conversation: {} as ChatSettingsSnapshot["conversation"],
    supportedFields: [],
    effective: {
      enabled: true,
      activation: { mode: "mention", botMessages: "ignore", whenOthersMentioned: "ignore" },
      replies: { placement: "thread" },
      routing: { agentName: null },
      session: { reset: { mode: "none" } },
    },
    overrides: {},
  } satisfies ChatSettingsSnapshot;
  const loader = wakeGateLoader({
    chatSettings: async () => snapshot,
    bondLevelsSetting: async () => null,
    policies: async () => [],
    connectionKindOf: (channel) => channel,
    servesWorkspace: (connectionId) => connectionId === "workspace",
  });
  const mention = (connectionId: string) => ({
    connectionId,
    chatId: "C1",
    channel: "slack_app",
    place: "group" as const,
    addressing: "mention" as const,
  });
  const member = { person: { id: "p1", bondLevel: "other" as const } };

  it("wakes the agent for anyone who mentions an account that serves its workspace", async () => {
    const gate = await loader({ chat: { connectionId: "workspace", chatId: "C1" as ChatId } });
    expect(gate(mention("workspace"), member)).toBe("wake");
  });

  it("keeps a member below the reply-to levels quiet on any other account", async () => {
    const gate = await loader({ chat: { connectionId: "other", chatId: "C1" as ChatId } });
    expect(gate(mention("other"), member)).toBe("quiet");
  });
});
