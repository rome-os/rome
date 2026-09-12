import { ChannelType } from "discord.js";
import { describe, expect, it, rs } from "@rstest/core";
import { DiscordAdapter } from "./discord.js";

describe("DiscordAdapter.sendMessage", () => {
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
      adapter.sendMessage("discord-user-1", channel.id, {
        attachments: [
          {
            type: "document",
            source: "https://example.com/report.pdf",
            caption: "Report",
          },
        ],
      }),
    ).resolves.toEqual({
      messageId: "discord-attachment-1",
      threadId: channel.id,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
