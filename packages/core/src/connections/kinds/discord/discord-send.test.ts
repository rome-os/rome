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

  it("sends a quote under a nonce Discord enforces, so a resend returns the first message", async () => {
    const { channel, adapter, send } = chatOf(ChannelType.DM);

    await adapter.send(channel.id as ChatId, {
      text: "Re",
      replyToMessageId: "123456789012345678",
    });

    const options = send.mock.calls[0]?.[0] as { nonce?: unknown; enforceNonce?: unknown };
    expect(options.enforceNonce).toBe(true);
    expect(typeof options.nonce).toBe("string");
    expect((options.nonce as string).length).toBeLessThanOrEqual(25);
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

describe("DiscordAdapter.sendOnlyTo", () => {
  /** The adapter over a shared chat and the member's direct message, noting
   *  what is sent to each. */
  function privately(
    dmSend = rs.fn().mockResolvedValue({ id: "dm-message-1" }),
    createDM = rs.fn().mockResolvedValue({ id: "dm-alice", send: dmSend }),
  ) {
    const shared = { id: "guild-chat-1", send: rs.fn() };
    const fetch = rs.fn().mockResolvedValue(shared);
    const adapter = new DiscordAdapter({ botToken: "test-token" });
    Object.assign(adapter, { client: { users: { createDM }, channels: { fetch } } });
    return { adapter, createDM, dmSend, shared, fetch };
  }

  it("opens the direct message with that member and sends there, and nothing in the shared chat", async () => {
    const { adapter, createDM, dmSend, shared, fetch } = privately();

    await adapter.sendOnlyTo("alice", "Sign in here");

    expect(createDM).toHaveBeenCalledWith("alice");
    expect(dmSend).toHaveBeenCalledWith({ content: "Sign in here" });
    expect(shared.send).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  /** Discord's refusal with error `code`, as its API answers a direct
   *  message, or opening one when `path` is `/users/@me/channels`. */
  function refusal(
    code: number,
    message: string,
    status = 403,
    path = "/channels/dm-alice/messages",
  ) {
    return new DiscordAPIError({ code, message }, code, status, "POST", path, {});
  }

  it("refuses a member whose direct messages are closed as a refused private message", async () => {
    const closed = refusal(50007, "Cannot send messages to this user");
    const { adapter, shared } = privately(rs.fn().mockRejectedValue(closed));

    await expect(adapter.sendOnlyTo("alice", "Sign in here")).rejects.toMatchObject({
      name: "PrivateMessageRefused",
      accountId: "alice",
    });
    expect(shared.send).not.toHaveBeenCalled();
  });

  it("refuses a member who shares no server with the bot as a refused private message", async () => {
    const noServer = refusal(
      50278,
      "Cannot send messages to this user due to having no mutual guilds",
    );
    const { adapter, shared } = privately(rs.fn().mockRejectedValue(noServer));

    await expect(adapter.sendOnlyTo("alice", "Sign in here")).rejects.toMatchObject({
      name: "PrivateMessageRefused",
      accountId: "alice",
    });
    expect(shared.send).not.toHaveBeenCalled();
  });

  it("refuses a member Discord will not open a direct message with as a refused private message", async () => {
    const otherBot = refusal(
      50007,
      "Cannot send messages to this user",
      400,
      "/users/@me/channels",
    );
    const dmSend = rs.fn();
    const { adapter, shared } = privately(dmSend, rs.fn().mockRejectedValue(otherBot));

    await expect(adapter.sendOnlyTo("alice", "Sign in here")).rejects.toMatchObject({
      name: "PrivateMessageRefused",
      accountId: "alice",
      cause: otherBot,
    });
    expect(dmSend).not.toHaveBeenCalled();
    expect(shared.send).not.toHaveBeenCalled();
  });

  it("passes on a failure to open the direct message that is not about the member", async () => {
    const tooBusy = refusal(20029, "Server send rate limit reached", 429, "/users/@me/channels");
    const { adapter } = privately(rs.fn(), rs.fn().mockRejectedValue(tooBusy));

    await expect(adapter.sendOnlyTo("alice", "Sign in here")).rejects.toBe(tooBusy);
  });
});
