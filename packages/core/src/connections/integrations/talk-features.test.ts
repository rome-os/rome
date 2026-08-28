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
    const feature = historyFeature({
      fetchHistory: async () => Array.from({ length: 101 }, (_, index) => historyMessage(index)),
    });

    const messages = await feature.query({});

    expect(messages).toHaveLength(100);
    expect(messages.at(-1)?.messageId).toBe("message-99");
  });

  it("caps an explicit limit", async () => {
    const feature = historyFeature({
      fetchHistory: async () => Array.from({ length: 1_001 }, (_, index) => historyMessage(index)),
    });

    await expect(feature.query({ limit: 10_000 })).resolves.toHaveLength(1_000);
  });
});
