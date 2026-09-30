import { describe, expect, it } from "@rstest/core";
import type { NormalizedMessage } from "@rome-os/app-runtime";
import { historyFeature } from "./talk-features.js";

function historyMessage(index: number): NormalizedMessage {
  return {
    id: `message-${index}`,
    channel: "whatsapp",
    channelUserId: "user-1",
    displayName: "User",
    threadId: "conversation-1",
    threadType: "group",
    timestamp: new Date("2026-01-01T00:00:00.000Z"),
    text: `message ${index}`,
    attachments: [],
    rawEvent: {},
  };
}

describe("historyFeature", () => {
  it("returns a bounded default page when limit is omitted", async () => {
    const feature = historyFeature(
      {
        fetchHistory: async () => Array.from({ length: 101 }, (_, index) => historyMessage(index)),
      },
      { channel: "whatsapp" },
    );

    const messages = await feature.query({});

    expect(messages).toHaveLength(100);
    expect(messages.at(-1)?.messageId).toBe("message-99");
  });

  it("caps an explicit limit", async () => {
    const feature = historyFeature(
      {
        fetchHistory: async () =>
          Array.from({ length: 1_001 }, (_, index) => historyMessage(index)),
      },
      { channel: "whatsapp" },
    );

    await expect(feature.query({ limit: 10_000 })).resolves.toHaveLength(1_000);
  });

  it("answers the channel's record, marking the account's own lines outbound", async () => {
    const feature = historyFeature(
      {
        fetchHistory: async () => [
          historyMessage(0),
          { ...historyMessage(1), channelUserId: "me" },
        ],
      },
      { channel: "telegram_user", isOwn: (message) => message.channelUserId === "me" },
    );

    const messages = await feature.query({});

    expect(messages.map((message) => [message.channel, message.direction])).toEqual([
      ["telegram_user", "inbound"],
      ["telegram_user", "outbound"],
    ]);
  });
});
