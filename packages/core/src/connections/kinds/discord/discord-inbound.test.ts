import { mkdtemp, readFile, rm } from "node:fs/promises";
import { channelMessageOf } from "../../../chats/connected-accounts/channel-message.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelType, MessageReferenceType, MessageType, type Message } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { ChannelMessage, ChatId } from "@rome-os/app-runtime";
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
    captured.push(channelMessageOf(msg, "discord"));
  });
  return { adapter, captured };
}

/** Hands `message` over as the gateway handler does. Whom it addresses is
 *  worked out from its facts where apps receive it, so the cases name none. */
async function dispatch(
  adapter: DiscordAdapter,
  message: Message,
  flags: { isDm: boolean; isThread: boolean },
): Promise<void> {
  await (
    adapter as unknown as {
      dispatchMessage(message: Message, isDm: boolean, isThread: boolean): Promise<void>;
    }
  ).dispatchMessage(message, flags.isDm, flags.isThread);
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
      mentions: { users: new Map([[BOT.id, { displayName: "Rome" }]]) },
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

    await dispatch(adapter, message, { isDm: false, isThread: true });

    expect(captured).toStrictEqual([
      {
        channel: "discord",
        direction: "inbound",
        messageId: "msg-7",
        chatId: "thread-1",
        parentChatId: "channel-1",
        senderId: "user-1",
        senderDisplayName: "Alice Smith",
        senderUsername: "alice",
        text: "@Rome see this",
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
      mentions: { users: new Map() },
      attachments: new Map(),
    } as unknown as Message;

    await dispatch(adapter, message, { isDm: true, isThread: false });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      chatId: "dm-1",
      senderDisplayName: "Alice",
      thread: { kind: "dm" },
      addressing: "direct",
    });
    expect(captured[0].thread).toStrictEqual({ kind: "dm" });
    expect(captured[0]).not.toHaveProperty("parentChatId");
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
      mentions: { users: new Map() },
      attachments: new Map(),
    } as unknown as Message;

    await dispatch(adapter, message, { isDm: false, isThread: false });

    expect(captured[0].thread).toStrictEqual({ kind: "group", name: "general" });
    expect(captured[0]).not.toHaveProperty("parentChatId");
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
      chatId: "thread-1" as ChatId,
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
        chatId: "channel-1" as ChatId,
        senderId: "user-1",
        text: "",
        attachments,
        timestamp: new Date("2026-05-10T00:00:00Z"),
      }),
    ).resolves.toBe(attachments);
  });
});

/** A chat's settings, as the adapter reads them for every message. */
function chatSettingsOf(enabled: boolean) {
  return {
    get: async () => ({
      effective: {
        enabled,
        activation: { mode: "mention", botMessages: "ignore", whenOthersMentioned: "ignore" },
        replies: { placement: "inline" },
        routing: { agentName: null },
      },
    }),
  } as unknown as ConstructorParameters<typeof DiscordAdapter>[0]["chatSettings"];
}

/** An adapter started on a stand-in gateway: `say` delivers one message. */
async function startedAdapter(
  config: Omit<ConstructorParameters<typeof DiscordAdapter>[0], "botToken">,
): Promise<{ say: (message: Message) => Promise<void>; captured: ChannelMessage[] }> {
  const handlers = new Map<string, (message: Message) => Promise<void>>();
  const adapter = new DiscordAdapter({ botToken: "test-token", ...config });
  Object.assign(adapter, {
    client: {
      user: BOT,
      on: (event: string, handler: (message: Message) => Promise<void>) =>
        handlers.set(event, handler),
      login: async () => "test-token",
    },
  });
  const captured: ChannelMessage[] = [];
  adapter.onInbound(async (msg) => {
    captured.push(channelMessageOf(msg, "discord"));
  });
  await adapter.start();
  return { say: (message) => handlers.get("messageCreate")!(message), captured };
}

function guildMessage(
  id: string,
  content: string,
  more: { mentions?: string[]; bot?: boolean; webhook?: string } = {},
): Message {
  return {
    id,
    webhookId: more.webhook ?? null,
    channelId: "channel-1",
    content,
    createdAt: new Date("2026-05-10T00:00:00Z"),
    type: MessageType.Default,
    reference: null,
    author: {
      id: more.webhook ?? (more.bot ? "ci-bot" : "user-1"),
      username: "alice",
      displayName: "Alice",
      bot: more.bot,
    },
    member: { displayName: "Alice Smith" },
    guild: { members: { me: { displayName: "Rome" } } },
    channel: { type: ChannelType.GuildText, name: "general", isThread: () => false },
    mentions: {
      users: new Map(
        (more.mentions ?? []).map((user) => [
          user,
          { displayName: user === BOT.id ? "Rome" : user },
        ]),
      ),
    },
    attachments: new Map(),
  } as unknown as Message;
}

describe("DiscordAdapter gateway order", () => {
  it("hands over a chat's messages in the order they arrived, however slow a reply's lookup", async () => {
    const { say, captured } = await startedAdapter({
      connectionId: "conn-1",
      chatSettings: chatSettingsOf(true),
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reply = guildMessage("first", `<@${BOT.id}> stop that`, { mentions: [BOT.id] });
    Object.assign(reply, {
      type: MessageType.Reply,
      reference: {
        channelId: "channel-1",
        guildId: "guild-1",
        messageId: "earlier",
        type: MessageReferenceType.Default,
      },
      channel: {
        type: ChannelType.GuildText,
        name: "general",
        isThread: () => false,
        messages: {
          fetch: async () => {
            await held;
            return { author: { id: BOT.id } };
          },
        },
      },
    });

    const first = say(reply);
    const second = say(guildMessage("second", "/stop"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(captured.map((message) => message.messageId)).toEqual([]);
    release();
    await Promise.all([first, second]);

    expect(captured.map((message) => message.messageId)).toEqual(["first", "second"]);
  });
});

describe("DiscordAdapter gateway filters", () => {
  it("hands over every message in a chat switched off, since keeping them is Rome's call", async () => {
    const { say, captured } = await startedAdapter({
      connectionId: "conn-1",
      chatSettings: chatSettingsOf(false),
    });

    await say(guildMessage("m1", "hi"));
    await say(guildMessage("m2", `<@${BOT.id}> /stop`, { mentions: [BOT.id] }));

    expect(captured.map((m) => [m.messageId, m.text])).toStrictEqual([
      ["m1", "hi"],
      ["m2", "/stop"],
    ]);
  });

  it("hears every message in a chat switched on, and tells how each addressed Rome", async () => {
    const { say, captured } = await startedAdapter({
      connectionId: "conn-1",
      // The chat answers mentions only and ignores bots and mentions of others,
      // which is the wake gate's call now, not the connection's.
      chatSettings: chatSettingsOf(true),
    });

    await say(guildMessage("m1", "the demo moved to Thursday"));
    await say(guildMessage("m2", "<@grace> can you take the notes?", { mentions: ["grace"] }));
    await say(
      guildMessage("m3", `<@grace> <@${BOT.id}> what is left?`, { mentions: ["grace", BOT.id] }),
    );
    await say(guildMessage("m4", `<@${BOT.id}> build passed`, { mentions: [BOT.id], bot: true }));
    await say(
      guildMessage("w1", `<@${BOT.id}> who owns Orkney?`, {
        mentions: [BOT.id],
        bot: true,
        webhook: "member-webhook",
      }),
    );
    await say(
      guildMessage("w2", `<@${BOT.id}> deploy finished`, {
        mentions: [BOT.id],
        bot: true,
        webhook: "ci-webhook",
      }),
    );

    expect(
      captured.map((m) => [
        m.messageId,
        m.addressing,
        m.fromBot ?? false,
        m.mentionsOthers ?? false,
      ]),
    ).toStrictEqual([
      ["m1", "ambient", false, false],
      ["m2", "ambient", false, true],
      ["m3", "mention", false, false],
      // Every bot's message is a bot's, as Discord says, webhooks included.
      ["m4", "mention", true, false],
      ["w1", "mention", true, false],
      ["w2", "mention", true, false],
    ]);
    // The text is what a person sees, Rome's own mention included.
    expect(captured.find((m) => m.messageId === "m3")?.text).toBe("@grace @Rome what is left?");
  });
});
