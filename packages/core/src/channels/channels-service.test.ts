import { describe, expect, it, rs } from "@rstest/core";
import type {
  ChannelMessage,
  ChannelsService,
  ConversationId,
  MessageReceipt,
} from "@rome-os/app-runtime";
import type { Channels } from "./channel.js";
import { createChannelsService, type ChannelsServiceDeps } from "./channels-service.js";
import type { Connection } from "../connections/types.js";

// The name-keyed service app actions send and read through, in the main
// process and, over RPC, in a worker. It chooses the Connection itself.

const CONNECTIONS = [
  { connectionId: "discord-1", service: "discord" },
  { connectionId: "tg-a", service: "telegram_user" },
  { connectionId: "tg-b", service: "telegram_user" },
];

function line(id: string, at: number): ChannelMessage {
  return {
    channel: "whatsapp",
    direction: "inbound",
    messageId: id,
    conversationId: "c1" as ConversationId,
    senderId: "s1",
    text: id,
    attachments: [],
    timestamp: new Date(at),
  };
}

const RECEIPT: MessageReceipt = { messageId: "m1", conversationId: "c1" as ConversationId };

/** A registry holding `connections`, each with a Talk that sends through
 *  `send`, told which Connection is sending. */
function registryOf(
  connections: Array<{ connectionId: string; service: string }>,
  send: (...args: never[]) => unknown,
): ChannelsServiceDeps["registry"] {
  const all = connections.map(({ connectionId, service }) => {
    const talk = {
      send: (...args: unknown[]) => (send as (...a: unknown[]) => unknown)(connectionId, ...args),
    };
    return {
      id: connectionId,
      service,
      talk,
      status: () => ({ talk: { state: "unlocked" } }),
    } as unknown as Connection;
  });
  return {
    all: () => all,
    get: (id) => {
      const connection = all.find((each) => each.id === id);
      if (!connection) throw new Error(`unknown connection "${id}"`);
      return connection;
    },
  };
}

function service(channels: unknown[] = []) {
  const send = rs.fn<ChannelsService["send"]>(async () => RECEIPT);
  const channelsService = createChannelsService({
    channels: () => channels as Channels,
    registry: registryOf(CONNECTIONS, send),
  });
  return { channelsService, send };
}

describe("createChannelsService", () => {
  it("lists each channel with the Connections backing it", async () => {
    const { channelsService } = service([
      { name: "discord", messages: null },
      { name: "whatsapp", messages: null },
    ]);

    expect(await channelsService.list()).toEqual([
      { name: "discord", connectionIds: ["discord-1"] },
      { name: "telegram_user", connectionIds: ["tg-a", "tg-b"] },
      { name: "whatsapp", connectionIds: [] },
    ]);
  });

  // The main process hands the service out before it builds the channel list,
  // and startup hooks and approval cards can reach it in between.
  it("lists and sends from the Connections alone before the channel list exists", async () => {
    const send = rs.fn<ChannelsService["send"]>(async () => RECEIPT);
    const early = createChannelsService({
      channels: () => undefined,
      registry: registryOf(CONNECTIONS, send),
    });

    expect((await early.list()).map((channel) => channel.name)).toEqual([
      "discord",
      "telegram_user",
    ]);
    await early.send("discord", "c1" as ConversationId, { text: "hi" });
    expect(send).toHaveBeenCalledWith("discord-1", "c1", { text: "hi" });
    await expect(early.query("discord")).rejects.toThrow('Channel "discord" reads no messages');
  });

  it("sends through a channel's only Connection", async () => {
    const { channelsService, send } = service();

    const receipt = await channelsService.send("discord", "c1" as ConversationId, { text: "hi" });

    expect(receipt).toEqual(RECEIPT);
    expect(send).toHaveBeenCalledWith("discord-1", "c1", { text: "hi" });
  });

  it("sends through the Connection an action names", async () => {
    const { channelsService, send } = service();

    await channelsService.send(
      "telegram_user",
      "c1" as ConversationId,
      { text: "hi" },
      {
        connectionId: "tg-b",
      },
    );

    expect(send).toHaveBeenCalledWith("tg-b", "c1", { text: "hi" });
  });

  it("refuses a Connection it cannot choose", async () => {
    const { channelsService, send } = service();
    const to = "c1" as ConversationId;

    await expect(channelsService.send("telegram_user", to, { text: "hi" })).rejects.toThrow(
      'Channel "telegram_user" has multiple connections; connectionId is required',
    );
    await expect(channelsService.send("whatsapp", to, { text: "hi" })).rejects.toThrow(
      'No Talk connection registered for "whatsapp"',
    );
    await expect(
      channelsService.send("discord", to, { text: "hi" }, { connectionId: "tg-a" }),
    ).rejects.toThrow('Connection "tg-a" does not provide channel "discord"');
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

  // `history` is deprecated: it reads `query` and answers the page oldest first.
  it("reads history through the channel's query, oldest first", async () => {
    const query = rs.fn(async () => [line("newer", 2_000), line("older", 1_000)]);
    const { channelsService } = service([
      { name: "whatsapp", messages: { query, byAccount: null } },
      { name: "discord", messages: null },
    ]);
    const since = new Date(0);

    const page = await channelsService.history("whatsapp", {
      conversationId: "c1" as ConversationId,
      since,
      limit: 5,
    });

    expect(page.map((m) => m.messageId)).toEqual(["older", "newer"]);
    expect(query).toHaveBeenCalledWith({ conversationId: "c1", since, limit: 5 });
    await expect(channelsService.history("discord", {})).rejects.toThrow(
      'Channel "discord" reads no messages',
    );
  });
});
