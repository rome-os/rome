import { MessageReferenceType, MessageType } from "discord.js";
import { describe, expect, it } from "@rstest/core";
import { resolveDiscordReplyToMessageId } from "./discord.js";

describe("resolveDiscordReplyToMessageId", () => {
  it("keeps the referenced message ID for an actual reply", () => {
    expect(
      resolveDiscordReplyToMessageId({
        type: MessageType.Reply,
        reference: {
          channelId: "channel-1",
          guildId: "guild-1",
          messageId: "message-1",
          type: MessageReferenceType.Default,
        },
      }),
    ).toBe("message-1");
  });

  it("does not treat a forwarded message as a reply", () => {
    expect(
      resolveDiscordReplyToMessageId({
        type: MessageType.Default,
        reference: {
          channelId: "source-channel",
          guildId: "guild-1",
          messageId: "source-message",
          type: MessageReferenceType.Forward,
        },
      }),
    ).toBeUndefined();
  });

  it("does not treat other generic Discord references as replies", () => {
    expect(
      resolveDiscordReplyToMessageId({
        type: MessageType.ThreadStarterMessage,
        reference: {
          channelId: "parent-channel",
          guildId: "guild-1",
          messageId: "starter-message",
          type: MessageReferenceType.Default,
        },
      }),
    ).toBeUndefined();
  });
});
