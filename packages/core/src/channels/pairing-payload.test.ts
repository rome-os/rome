import { describe, expect, it } from "@rstest/core";
import { pairingPayload } from "@rome/api-types/approvals";

const stored = {
  action: "channel_pairing",
  channel: "telegram",
  connectionId: "bot",
  channelUserId: "123",
  displayName: "Alice",
  expiresAt: 1,
  failedAttempts: 0,
  lastGuidanceAt: 0,
};

describe("pairingPayload", () => {
  it("reads the chat of a request stored before the chat rename", () => {
    const payload = pairingPayload({
      type: "person_mapping",
      payload: { ...stored, conversationId: "dm" },
    });

    expect(payload?.chatId).toBe("dm");
    expect(payload).not.toHaveProperty("conversationId");
  });

  it("reads the chat of a request stored under its new name", () => {
    const payload = pairingPayload({
      type: "person_mapping",
      payload: { ...stored, chatId: "dm" },
    });

    expect(payload?.chatId).toBe("dm");
  });
});
