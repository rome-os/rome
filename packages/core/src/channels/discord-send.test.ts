import { ChannelType } from "discord.js";
import { describe, expect, it, rs } from "@rstest/core";
import type { ConversationId } from "@rome-os/app-runtime";
import { DiscordAdapter } from "./discord.js";

describe("DiscordAdapter.send", () => {
  it("opens the requester's DM and propagates provider refusal", async () => {
    const createDM = rs.fn().mockResolvedValue({ id: "dm-alice" });
    const adapter = new DiscordAdapter({ botToken: "test-token" });
    Object.assign(adapter, { client: { users: { createDM } } });
    await expect(adapter.directConversationFor("alice")).resolves.toBe("dm-alice");
    expect(createDM).toHaveBeenCalledWith("alice");
    createDM.mockRejectedValueOnce(new Error("DM unavailable"));
    await expect(adapter.directConversationFor("alice")).rejects.toThrow("DM unavailable");
  });

  it("returns the provider message id for an attachment-only delivery", async () => {
    const send = rs.fn().mockResolvedValue({ id: "discord-attachment-1" });
    const channel = {
      id: "discord-thread-1",
      type: ChannelType.DM,
      isTextBased: () => true,
      isThread: () => false,
      send,
    };
    const adapter = new DiscordAdapter({ botToken: "test-token" });
    Object.assign(adapter, {
      client: {
        channels: {
          fetch: rs.fn().mockResolvedValue(channel),
        },
      },
    });

    await expect(
      adapter.send(channel.id as ConversationId, {
        attachments: [
          {
            type: "document",
            source: "https://example.com/report.pdf",
            caption: "Report",
          },
        ],
      }),
    ).resolves.toStrictEqual({
      conversationId: channel.id,
      messageId: "discord-attachment-1",
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("leaves messageId out of the receipt when nothing was sent", async () => {
    const channel = {
      id: "discord-thread-1",
      type: ChannelType.DM,
      isTextBased: () => true,
      isThread: () => false,
      send: rs.fn(),
    };
    const adapter = new DiscordAdapter({ botToken: "test-token" });
    Object.assign(adapter, {
      client: { channels: { fetch: rs.fn().mockResolvedValue(channel) } },
    });

    await expect(adapter.send(channel.id as ConversationId, {})).resolves.toStrictEqual({
      conversationId: channel.id,
    });
  });
});
