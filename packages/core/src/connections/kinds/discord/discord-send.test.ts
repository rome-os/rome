import { ChannelType, DiscordAPIError } from "discord.js";
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

  it("refuses a message with nothing to send", async () => {
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

    await expect(adapter.send(channel.id as ChatId, {})).rejects.toMatchObject({
      name: "ChannelSendRefused",
      reason: "empty",
    });
    expect(channel.send).not.toHaveBeenCalled();
  });

  /** A chat of `type` and the adapter over it, noting every message sent. */
  function chatOf(type: ChannelType, send = rs.fn().mockResolvedValue({ id: "sent-1" })) {
    const channel = {
      id: "discord-chat-1",
      type,
      isTextBased: () => true,
      isThread: () => type === ChannelType.PublicThread,
      parentId: type === ChannelType.PublicThread ? "parent-1" : null,
      send,
    };
    const adapter = new DiscordAdapter({ botToken: "test-token" });
    Object.assign(adapter, {
      client: { channels: { fetch: rs.fn().mockResolvedValue(channel) } },
    });
    return { channel, adapter, send };
  }

  for (const [where, type] of [
    ["a DM", ChannelType.DM],
    ["a thread", ChannelType.PublicThread],
  ] as const) {
    it(`quotes the message a reply answers in ${where}, on its first message only`, async () => {
      const { channel, adapter, send } = chatOf(type);
      const replyToMessageId = "123456789012345678";

      await adapter.send(channel.id as ChatId, {
        text: `${"a".repeat(1990)}\n${"b".repeat(20)}`,
        replyToMessageId,
      });

      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[0]?.[0]).toMatchObject({
        reply: { messageReference: replyToMessageId, failIfNotExists: true },
      });
      expect(send.mock.calls[1]?.[0]).not.toHaveProperty("reply");
    });
  }

  it("quotes on the attachment when a reply has no text", async () => {
    const { channel, adapter, send } = chatOf(ChannelType.DM);

    await adapter.send(channel.id as ChatId, {
      replyToMessageId: "123456789012345678",
      attachments: [{ type: "image", source: "https://example.com/a.png" }],
    });

    expect(send.mock.calls[0]?.[0]).toMatchObject({
      reply: { messageReference: "123456789012345678" },
    });
  });

  it("refuses a reply to a message Discord cannot find", async () => {
    const unknown = new DiscordAPIError(
      {
        code: 50035,
        message: "Invalid Form Body",
        errors: { message_reference: { _errors: [{ code: "REPLIES_UNKNOWN_MESSAGE" }] } },
      } as never,
      50035,
      400,
      "POST",
      "/channels/discord-chat-1/messages",
      {},
    );
    const { channel, adapter } = chatOf(ChannelType.DM, rs.fn().mockRejectedValue(unknown));

    await expect(
      adapter.send(channel.id as ChatId, { text: "Re", replyToMessageId: "123456789012345678" }),
    ).rejects.toMatchObject({ name: "ChannelSendRefused", reason: "reply_unaddressable" });
  });

  it("refuses a reply where the bot may not read the chat's history", async () => {
    const noHistory = new DiscordAPIError(
      { code: 160002, message: "Cannot reply without permission to read message history" },
      160002,
      403,
      "POST",
      "/channels/discord-chat-1/messages",
      {},
    );
    const { channel, adapter } = chatOf(ChannelType.DM, rs.fn().mockRejectedValue(noHistory));

    await expect(
      adapter.send(channel.id as ChatId, { text: "Re", replyToMessageId: "123456789012345678" }),
    ).rejects.toMatchObject({ name: "ChannelSendRefused", reason: "reply_unaddressable" });
  });

  it("passes on an invalid form that is not the quote's fault", async () => {
    const tooLong = new DiscordAPIError(
      {
        code: 50035,
        message: "Invalid Form Body",
        errors: { content: { _errors: [{ code: "BASE_TYPE_MAX_LENGTH" }] } },
      } as never,
      50035,
      400,
      "POST",
      "/channels/discord-chat-1/messages",
      {},
    );
    const { channel, adapter } = chatOf(ChannelType.DM, rs.fn().mockRejectedValue(tooLong));

    await expect(
      adapter.send(channel.id as ChatId, { text: "Re", replyToMessageId: "123456789012345678" }),
    ).rejects.toBe(tooLong);
  });

  it("quotes without mentioning the author of the quoted message", async () => {
    const { channel, adapter, send } = chatOf(ChannelType.DM);

    await adapter.send(channel.id as ChatId, {
      text: "Re",
      replyToMessageId: "123456789012345678",
    });

    expect(send.mock.calls[0]?.[0]).toMatchObject({
      allowedMentions: { parse: ["users", "roles", "everyone"], repliedUser: false },
    });
  });

  it("passes on a failure of a send that quotes nothing", async () => {
    const unknown = new DiscordAPIError(
      { code: 50035, message: "Invalid Form Body" },
      50035,
      400,
      "POST",
      "/channels/discord-chat-1/messages",
      {},
    );
    const { channel, adapter } = chatOf(ChannelType.DM, rs.fn().mockRejectedValue(unknown));

    await expect(adapter.send(channel.id as ChatId, { text: "Hi" })).rejects.toBe(unknown);
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
