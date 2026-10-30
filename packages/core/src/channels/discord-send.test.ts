import { ChannelType } from "discord.js";
import { describe, expect, it, rs } from "@rstest/core";
import type { ChatId } from "@rome-os/app-runtime";
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
      adapter.send(channel.id as ChatId, {
        attachments: [
          {
            type: "document",
            source: "https://example.com/report.pdf",
            caption: "Report",
          },
        ],
      }),
    ).resolves.toStrictEqual({
      chatId: channel.id,
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

    await expect(adapter.send(channel.id as ChatId, {})).resolves.toStrictEqual({
      chatId: channel.id,
    });
  });
});

describe("DiscordAdapter.replyDelivery", () => {
  /** A guild text channel whose user message has no thread yet, and the
   *  adapter's client over it, noting every message the transport posts. */
  function guild(placement?: "inline") {
    const startThread = rs.fn().mockResolvedValue({ id: "thread-1" });
    const channel = {
      id: "chan-1",
      type: ChannelType.GuildText,
      name: "general",
      guild: { name: "Guild" },
      isTextBased: () => true,
      isThread: () => false,
      messages: { fetch: rs.fn().mockResolvedValue({ content: "hi", thread: null, startThread }) },
    };
    const posted: string[] = [];
    const adapter = new DiscordAdapter({
      botToken: "test-token",
      connectionId: "discord-test",
      ...(placement
        ? {
            chatSettings: {
              get: async () => ({ effective: { replies: { placement } } }),
            } as never,
          }
        : {}),
    });
    Object.assign(adapter, {
      client: {
        channels: { fetch: rs.fn().mockResolvedValue(channel) },
        rest: {
          post: async (route: string) => {
            posted.push(route);
            return { id: "m-1", channel_id: route.split("/")[2] };
          },
        },
      },
    });
    return { adapter, posted, startThread };
  }

  it("streams a reply into the thread a whole reply opens on the user's message", async () => {
    const { adapter, posted, startThread } = guild();

    await expect(adapter.replyDelivery().create("chan-1", "hello", "user-1")).resolves.toEqual({
      messageId: "m-1",
      chatId: "thread-1",
    });
    expect(startThread).toHaveBeenCalledTimes(1);
    expect(posted).toEqual(["/channels/thread-1/messages"]);
  });

  it("streams a reply into the channel where its settings keep replies inline", async () => {
    const { adapter, posted, startThread } = guild("inline");

    await adapter.replyDelivery().create("chan-1", "hello", "user-1");
    expect(startThread).not.toHaveBeenCalled();
    expect(posted).toEqual(["/channels/chan-1/messages"]);
  });
});
