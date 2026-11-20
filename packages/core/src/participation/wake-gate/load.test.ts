import { describe, expect, it } from "@rstest/core";
import type { ChatSettingsSnapshot } from "@rome-os/app-runtime";
import { chatRules } from "./index.js";

function snapshot(supportedFields: ChatSettingsSnapshot["supportedFields"]): ChatSettingsSnapshot {
  return {
    conversation: {} as ChatSettingsSnapshot["conversation"],
    supportedFields,
    effective: {
      enabled: true,
      activation: { mode: "mention", botMessages: "ignore", whenOthersMentioned: "ignore" },
      replies: { placement: "thread" },
      routing: { agentName: null },
      session: { reset: { mode: "none" } },
    },
    overrides: {},
  };
}

describe("chatRules", () => {
  it("applies the settings a Discord chat offers", () => {
    expect(
      chatRules(
        snapshot([
          "enabled",
          "activation.mode",
          "activation.botMessages",
          "activation.whenOthersMentioned",
        ]),
      ),
    ).toEqual({
      enabled: true,
      replyRule: "mention",
      botMessages: "ignore",
      whenOthersMentioned: "ignore",
    });
  });

  it("wakes on every message where the connection offers no reply rule, as on Telegram", () => {
    expect(chatRules(snapshot(["session.reset"]))).toEqual({
      enabled: true,
      replyRule: "all",
      botMessages: "all",
      whenOthersMentioned: "respond",
    });
  });
});
