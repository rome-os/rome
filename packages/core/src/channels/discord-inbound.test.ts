import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelType, MessageReferenceType, MessageType, type Message } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { ChannelMessage, ConversationId, MessageAddressing } from "@rome-os/app-runtime";
import { DiscordAdapter } from "./discord.js";

// The gateway filters run before dispatchMessage. These tests call it directly
// with a discord.js-shaped message, so they pin the record the transport emits
// for one message that already passed them.

const BOT = { id: "bot-1", displayName: "Rome" };

function adapterCapturing(): { adapter: DiscordAdapter; captured: ChannelMessage[] } {
  const adapter = new DiscordAdapter({ botToken: "test-token" });
  Object.assign(adapter, { client: { user: BOT } });
  const captured: ChannelMessage[] = [];
  adapter.onInbound(async (msg) => {
    captured.push(msg);
  });
  return { adapter, captured };
}

async function dispatch(
  adapter: DiscordAdapter,
  message: Message,
  flags: { isDm: boolean; isThread: boolean; addressing: MessageAddressing },
): Promise<void> {
  await (
    adapter as unknown as {
      dispatchMessage(
        message: Message,
        isDm: boolean,
        isThread: boolean,
        addressing: MessageAddressing,
      ): Promise<void>;
    }
  ).dispatchMessage(message, flags.isDm, flags.isThread, flags.addressing);
}

describe("DiscordAdapter inbound messages", () => {
  it("emits a native-thread message as a topic under its parent channel, with the discord.js message as raw", async () => {
    const { adapter, captured } = adapterCapturing();
    const createdAt = new Date("2026-05-10T00:00:00Z");
    const message = {
      id: "msg-7",
      channelId: "thread-1",
      content: `<@${BOT.id}> see this`,
      createdAt,
      type: MessageType.Reply,
      reference: {
        channelId: "thread-1",
        guildId: "guild-1",
        messageId: "msg-5",
        type: MessageReferenceType.Default,
      },
      author: { id: "user-1", username: "alice", displayName: "Alice" },
      member: { displayName: "Alice Smith" },
      guild: { members: { me: { displayName: "Rome" } } },
      channel: {
        type: ChannelType.PublicThread,
        name: "launch",
        parentId: "channel-1",
        isThread: () => true,
      },
      attachments: new Map([
        [
          "att-1",
          {
            url: "https://cdn.discordapp.com/attachments/1/2/photo.png",
            name: "photo.png",
            title: null,
            contentType: "image/png",
          },
        ],
      ]),
    } as unknown as Message;

    await dispatch(adapter, message, { isDm: false, isThread: true, addressing: "mention" });

    expect(captured).toStrictEqual([
      {
        channel: "discord",
        direction: "inbound",
        messageId: "msg-7",
        conversationId: "thread-1",
        parentConversationId: "channel-1",
        senderId: "user-1",
        senderDisplayName: "Alice Smith",
        senderUsername: "alice",
        text: "see this",
        attachments: [
          {
            type: "image",
            url: "https://cdn.discordapp.com/attachments/1/2/photo.png",
            fileName: "photo.png",
          },
        ],
        timestamp: createdAt,
        replyTo: { messageId: "msg-5" },
        addressing: "mention",
        thread: { kind: "topic", name: "launch" },
        raw: message,
      },
    ]);
  });

  it("emits a direct message as a dm with no parent, reply or thread name", async () => {
    const { adapter, captured } = adapterCapturing();
    const message = {
      id: "msg-1",
      channelId: "dm-1",
      content: "hello",
      createdAt: new Date("2026-05-10T00:00:00Z"),
      type: MessageType.Default,
      reference: null,
      author: { id: "user-1", username: "alice", displayName: "Alice" },
      member: null,
      guild: null,
      channel: { type: ChannelType.DM, isThread: () => false },
      attachments: new Map(),
    } as unknown as Message;

    await dispatch(adapter, message, { isDm: true, isThread: false, addressing: "direct" });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      conversationId: "dm-1",
      senderDisplayName: "Alice",
      thread: { kind: "dm" },
      addressing: "direct",
    });
    expect(captured[0].thread).toStrictEqual({ kind: "dm" });
    expect(captured[0]).not.toHaveProperty("parentConversationId");
    expect(captured[0]).not.toHaveProperty("replyTo");
  });

  it("emits a guild channel message as a group named after the channel", async () => {
    const { adapter, captured } = adapterCapturing();
    const message = {
      id: "msg-2",
      channelId: "channel-1",
      content: "hi",
      createdAt: new Date("2026-05-10T00:00:00Z"),
      type: MessageType.Default,
      reference: null,
      author: { id: "user-1", username: "alice", displayName: "Alice" },
      member: { displayName: "Alice Smith" },
      guild: { members: { me: { displayName: "Rome" } } },
      channel: { type: ChannelType.GuildText, name: "general", isThread: () => false },
      attachments: new Map(),
    } as unknown as Message;

    await dispatch(adapter, message, { isDm: false, isThread: false, addressing: "ambient" });

    expect(captured[0].thread).toStrictEqual({ kind: "group", name: "general" });
    expect(captured[0]).not.toHaveProperty("parentConversationId");
  });
});

describe("DiscordAdapter.saveIncomingAttachments", () => {
  let sandboxHome: string;

  beforeEach(async () => {
    sandboxHome = await mkdtemp(join(tmpdir(), "rome-discord-"));
    rs.stubEnv("HOME", sandboxHome);
    rs.stubEnv("ROME_PROFILE", "discord-test");
  });

  afterEach(async () => {
    rs.unstubAllGlobals();
    rs.unstubAllEnvs();
    await rm(sandboxHome, { recursive: true, force: true });
  });

  it("downloads from the attachment URL, with no provider event in raw", async () => {
    const body = Buffer.from("image-data");
    rs.stubGlobal(
      "fetch",
      rs.fn(async () => new Response(body, { headers: { "content-type": "image/png" } })),
    );
    const adapter = new DiscordAdapter({ botToken: "test-token" });

    const attachments = await adapter.saveIncomingAttachments({
      channel: "discord",
      direction: "inbound",
      messageId: "msg-7",
      conversationId: "thread-1" as ConversationId,
      senderId: "user-1",
      text: "",
      attachments: [{ type: "image", url: "https://cdn.discordapp.com/attachments/1/2/photo.png" }],
      timestamp: new Date("2026-05-10T00:00:00Z"),
    });

    expect(attachments).toHaveLength(1);
    expect(attachments[0].localPath).toContain(sandboxHome);
    // Saved under the same channel/conversation/message path as before.
    expect(attachments[0].localPath).toContain(
      join("channel-attachments", "discord", "thread-1", "msg-7"),
    );
    await expect(readFile(attachments[0].localPath!)).resolves.toEqual(body);
  });

  it("returns the attachments unchanged when none has a URL", async () => {
    const adapter = new DiscordAdapter({ botToken: "test-token" });
    const attachments = [{ type: "document" as const, fileName: "a.pdf" }];

    await expect(
      adapter.saveIncomingAttachments({
        channel: "discord",
        direction: "inbound",
        messageId: "msg-8",
        conversationId: "channel-1" as ConversationId,
        senderId: "user-1",
        text: "",
        attachments,
        timestamp: new Date("2026-05-10T00:00:00Z"),
      }),
    ).resolves.toBe(attachments);
  });
});
