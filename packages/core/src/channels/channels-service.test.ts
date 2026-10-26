import { describe, expect, it, rs } from "@rstest/core";
import type { ChannelMessage, ChannelsService, ChatId, MessageReceipt } from "@rome-os/app-runtime";
import type { Channels } from "./channel.js";
import {
  backingConnection,
  emailConnection,
  createChannelsService,
  type ChannelsServiceDeps,
} from "./channels-service.js";
import { recordedChannelOf } from "./connection-ports.js";
import type { Connection } from "../connections/types.js";
import { kindChannelOf } from "../test/helpers.js";

// The name-keyed service app actions send and read through, in the main
// process and, over RPC, in a worker. It finds the Connection itself.

const CONNECTIONS = [
  { connectionId: "discord-1", service: "discord" },
  { connectionId: "tg-a", service: "telegram_user" },
];

function line(id: string, at: number): ChannelMessage {
  return {
    channel: "whatsapp",
    direction: "inbound",
    messageId: id,
    chatId: "c1" as ChatId,
    senderId: "s1",
    text: id,
    attachments: [],
    timestamp: new Date(at),
  };
}

const RECEIPT: MessageReceipt = { messageId: "m1", chatId: "c1" as ChatId };

/** A registry holding `connections`, each with a talker that sends through
 *  `send`, told which Connection is sending. */
function registryOf(
  connections: Array<{ connectionId: string; service: string }>,
  send: (...args: never[]) => unknown,
): ChannelsServiceDeps["registry"] {
  const all = connections.map(({ connectionId, service }) => {
    const talker = {
      send: (...args: unknown[]) => (send as (...a: unknown[]) => unknown)(connectionId, ...args),
    };
    return {
      id: connectionId,
      connectionKind: service,
      withTalker: (call: (live: typeof talker) => unknown) => call(talker),
      status: () => ({ chat: { state: "unlocked" } }),
    } as unknown as Connection;
  });
  return { all: () => all };
}

function service(channels: unknown[] = []) {
  const send = rs.fn<ChannelsService["send"]>(async () => RECEIPT);
  const channelsService = createChannelsService({
    channels: () => channels as Channels,
    registry: registryOf(CONNECTIONS, send),
    channelOf: kindChannelOf,
    platformOf: (channel) => (channel === "whatsapp" ? "whatsapp" : null),
  });
  return { channelsService, send };
}

describe("createChannelsService", () => {
  it("lists each channel, its platform, and whether a Connection backs it", async () => {
    const { channelsService } = service([
      { name: "discord", messages: null },
      { name: "whatsapp", messages: null },
      { name: "unrecorded", messages: null },
    ]);

    expect(await channelsService.list()).toEqual([
      { name: "discord", platform: "discord", sendable: true },
      // A signed-in Telegram is an account on the Telegram platform.
      { name: "telegram_user", platform: "telegram", sendable: true },
      { name: "whatsapp", platform: "whatsapp", sendable: false },
      { name: "unrecorded", sendable: false },
    ]);
  });

  it("names the platform of an account whose channel has an opaque id", async () => {
    const send = rs.fn<ChannelsService["send"]>(async () => RECEIPT);
    const channelsService = createChannelsService({
      channels: () => undefined,
      registry: registryOf([{ connectionId: "tg-b", service: "telegram" }], send),
      channelOf: () => "b1f0c3d2-0000-4000-8000-000000000001",
    });

    expect(await channelsService.list()).toEqual([
      { name: "b1f0c3d2-0000-4000-8000-000000000001", platform: "telegram", sendable: true },
    ]);
  });

  // Feishu and Lark are one kind of connection but two platforms, told apart
  // by the app's domain, which the channel's record carries.
  it("reads a recorded channel's platform from its record", async () => {
    const send = rs.fn<ChannelsService["send"]>(async () => RECEIPT);
    const channelsService = createChannelsService({
      channels: () => undefined,
      registry: registryOf([{ connectionId: "fs-a", service: "feishu" }], send),
      channelOf: () => "feishu",
      platformOf: () => "lark",
    });

    expect(await channelsService.list()).toEqual([
      { name: "feishu", platform: "lark", sendable: true },
    ]);
  });

  // The main process hands the service out before it builds the channel list,
  // and startup hooks and approval cards can reach it in between.
  it("lists and sends from the Connections alone before the channel list exists", async () => {
    const send = rs.fn<ChannelsService["send"]>(async () => RECEIPT);
    const early = createChannelsService({
      channels: () => undefined,
      registry: registryOf(CONNECTIONS, send),
      channelOf: kindChannelOf,
    });

    expect((await early.list()).map((channel) => channel.name)).toEqual([
      "discord",
      "telegram_user",
    ]);
    await early.send("discord", "c1" as ChatId, { text: "hi" });
    expect(send).toHaveBeenCalledWith("discord-1", "c1", { text: "hi" });
    await expect(early.query("discord")).rejects.toThrow('Channel "discord" reads no messages');
  });

  it("sends through the Connection backing the channel", async () => {
    const { channelsService, send } = service();

    const receipt = await channelsService.send("telegram_user", "c1" as ChatId, {
      text: "hi",
    });

    expect(receipt).toEqual(RECEIPT);
    expect(send).toHaveBeenCalledWith("tg-a", "c1", { text: "hi" });
  });

  it("refuses a channel no Connection backs", async () => {
    const { channelsService, send } = service();

    await expect(channelsService.send("whatsapp", "c1" as ChatId, { text: "hi" })).rejects.toThrow(
      'No Talk connection registered for "whatsapp"',
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("neither lists nor sends through a Connection with no channel record", async () => {
    const send = rs.fn<ChannelsService["send"]>(async () => RECEIPT);
    const registry = registryOf(CONNECTIONS, send);
    // discord-1 has lost its record, as while `registry.remove` evicts it.
    const channelOf = recordedChannelOf(
      { idOf: (id) => (id === "tg-a" ? "telegram_user" : null) },
      () => true,
    );
    const channelsService = createChannelsService({
      channels: () => undefined,
      registry,
      channelOf,
    });

    expect(backingConnection(registry, "discord", channelOf)).toBeUndefined();
    expect((await channelsService.list()).map((channel) => channel.name)).toEqual([
      "telegram_user",
    ]);
    await expect(channelsService.send("discord", "c1" as ChatId, { text: "hi" })).rejects.toThrow(
      'No Talk connection registered for "discord"',
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("queries a channel's messages, and says when it has none", async () => {
    const query = rs.fn(async () => [line("m", 1_000)]);
    const { channelsService } = service([
      { name: "whatsapp", messages: { query, byAccount: null } },
      { name: "discord", messages: null },
    ]);

    const page = await channelsService.query("whatsapp", { limit: 3 });

    expect(page.map((m) => m.messageId)).toEqual(["m"]);
    expect(query).toHaveBeenCalledWith({ limit: 3 });
    await expect(channelsService.query("discord")).rejects.toThrow(
      'Channel "discord" reads no messages',
    );
  });

  it("puts a cursor on each message and resumes after one", async () => {
    const query = rs.fn(async () => [line("m2", 2_000), line("m1", 1_000)]);
    const { channelsService } = service([
      { name: "whatsapp", messages: { query, byAccount: null } },
    ]);

    const page = await channelsService.query("whatsapp", { limit: 2 });
    const cursor = page.at(-1)?.cursor;
    expect(cursor).toEqual(expect.any(String));
    await channelsService.query("whatsapp", { chatId: "c1" as ChatId, after: cursor, limit: 2 });

    expect(query).toHaveBeenLastCalledWith({
      chatId: "c1",
      limit: 2,
      after: expect.objectContaining({
        source: "whatsapp",
        timestamp: 1,
        ref: expect.stringContaining("m1"),
      }),
    });
    await expect(
      channelsService.query("whatsapp", { chatId: "c1" as ChatId, after: "not-a-cursor" }),
    ).rejects.toThrow("Invalid message cursor");
    // Paging walks back through one chat.
    await expect(channelsService.query("whatsapp", { after: cursor })).rejects.toThrow(
      "A query after a cursor names a chat",
    );
  });

  // TODO(0.8): remove with the migration getters.
  it("tells an app built on 0.6 how to migrate off history and connectionIds", async () => {
    const { channelsService } = service();
    const [summary] = await channelsService.list();

    expect(() => (channelsService as unknown as { history: unknown }).history).toThrow(
      "ChannelsService.history was removed in @rome-os/app-runtime 0.7",
    );
    expect(() => (summary as unknown as { connectionIds: unknown }).connectionIds).toThrow(
      "ChannelSummary.connectionIds was removed in @rome-os/app-runtime 0.7",
    );
    expect(JSON.parse(JSON.stringify(summary))).toEqual({
      name: "discord",
      platform: "discord",
      sendable: true,
    });
  });
});

describe("ChannelsService — a channel Rome serves itself", () => {
  it("sends through its own port and lists it as sendable, with no Connection behind it", async () => {
    const own = rs.fn<ChannelsService["send"]>(async () => RECEIPT);
    const webchat = {
      name: "webchat",
      send: {
        send: (chatId: ChatId, message: Parameters<ChannelsService["send"]>[2]) =>
          own("webchat", chatId, message),
      },
      inbound: null,
      accounts: null,
      directory: null,
      messages: null,
    };
    const channelsService = createChannelsService({
      channels: () => undefined,
      registry: { all: () => [] },
      channelOf: () => null,
      own: [webchat as unknown as Channels[number]],
    });

    await expect(
      channelsService.send("webchat", "sess-1" as ChatId, { text: "hi" }),
    ).resolves.toEqual(RECEIPT);
    expect(own).toHaveBeenCalledWith("webchat", "sess-1", { text: "hi" });
    expect(await channelsService.list()).toEqual([
      { name: "webchat", platform: "webchat", sendable: true },
    ]);
  });

  it("sends inbound mail to the email account, whatever its record is called", () => {
    const registry = registryOf(
      [
        { connectionId: "discord-1", service: "discord" },
        { connectionId: "mail-b", service: "email" },
      ],
      () => RECEIPT,
    );
    // Account B connected after A was removed, so its record has an opaque id.
    const opaque = recordedChannelOf(
      { idOf: (id) => (id === "mail-b" ? "4f1c" : null) },
      () => true,
    );
    expect(emailConnection(registry, opaque)?.id).toBe("mail-b");

    const both = registryOf(
      [
        { connectionId: "mail-b", service: "email" },
        { connectionId: "mail-a", service: "email" },
      ],
      () => RECEIPT,
    );
    const named = recordedChannelOf(
      { idOf: (id) => (id === "mail-a" ? "email" : "4f1c") },
      () => true,
    );
    expect(emailConnection(both, named)?.id).toBe("mail-a");
    expect(
      emailConnection(
        registryOf(CONNECTIONS, () => RECEIPT),
        named,
      ),
    ).toBeUndefined();
  });
});
