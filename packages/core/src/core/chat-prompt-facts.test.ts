import { describe, expect, it, rs } from "@rstest/core";
import type { UnseenMessage } from "../agent/index.js";
import { chatPromptFacts } from "./chat-prompt-facts.js";

const AMBIENT: UnseenMessage = {
  id: 7,
  senderName: "Bob",
  text: "ambient update",
  at: new Date("2026-08-03T08:01:00.000Z"),
  fromRome: false,
  quoted: null,
  quotesOutside: false,
};

const CHANNELS: Record<string, string> = {
  "chat-quiet": "quiet",
  "chat-telegram": "telegram",
  "chat-unknown": "gone",
};

function facts() {
  const seen = rs.fn((_ids: readonly number[], _chatId: string, _turnId: string) => undefined);
  const promptFacts = chatPromptFacts({
    facts: { unseen: () => [AMBIENT], seen },
    channelOfChat: (chatId) => CHANNELS[chatId] ?? null,
    channelSurface: (channel) =>
      channel === "quiet"
        ? { interactiveCards: false, promptContext: false }
        : channel === "telegram"
          ? { interactiveCards: false, promptContext: true }
          : null,
  });
  return { promptFacts, seen };
}

describe("chatPromptFacts", () => {
  it("answers none in a chat whose channel hands the agent every message", () => {
    expect(facts().promptFacts.unseen("chat-quiet")).toBeNull();
  });

  it("answers the unseen messages in a chat whose channel does not", () => {
    const { promptFacts } = facts();
    expect(promptFacts.unseen("chat-telegram")).toEqual([AMBIENT]);
    // A channel name no channel has reads as a messaging channel's.
    expect(promptFacts.unseen("chat-unknown")).toEqual([AMBIENT]);
    // So does a chat no channel opened.
    expect(promptFacts.unseen("chat-none")).toEqual([AMBIENT]);
  });

  it("passes what a turn was shown through", () => {
    const { promptFacts, seen } = facts();
    promptFacts.seen([7], "chat-telegram", "turn-1");
    expect(seen).toHaveBeenCalledWith([7], "chat-telegram", "turn-1");
  });
});
