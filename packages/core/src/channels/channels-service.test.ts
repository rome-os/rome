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
    conversationId: "c1" as ConversationId,
    senderId: "s1",
    text: id,
    attachments: [],
    timestamp: new Date(at),
  };
}

const RECEIPT: MessageReceipt = { messageId: "m1", conversationId: "c1" as ConversationId };

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
      service,
      withTalker: (call: (live: typeof talker) => unknown) => call(talker),
      status: () => ({ talk: { state: "unlocked" } }),
    } as unknown as Connection;
  });
  return { all: () => all };
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
  it("lists each channel and whether a Connection backs it", async () => {
    const { channelsService } = service([
      { name: "discord", messages: null },
      { name: "whatsapp", messages: null },
    ]);

    expect(await channelsService.list()).toEqual([
      { name: "discord", sendable: true },
      { name: "telegram_user", sendable: true },
      { name: "whatsapp", sendable: false },
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

  it("sends through the Connection backing the channel", async () => {
    const { channelsService, send } = service();

    const receipt = await channelsService.send("telegram_user", "c1" as ConversationId, {
      text: "hi",
    });

    expect(receipt).toEqual(RECEIPT);
    expect(send).toHaveBeenCalledWith("tg-a", "c1", { text: "hi" });
  });

  it("refuses a channel no Connection backs", async () => {
    const { channelsService, send } = service();

    await expect(
      channelsService.send("whatsapp", "c1" as ConversationId, { text: "hi" }),
    ).rejects.toThrow('No Talk connection registered for "whatsapp"');
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

  it("finds a channel's accounts by name, and says when it has no address book", async () => {
    const listAccounts = rs.fn(async () => ({
      accounts: [
        {
          id: "a1",
          name: "atlas (dot)",
          addresses: ["a1"],
          identifiers: { "agents:id": "a1" },
        },
      ],
    }));
    const { channelsService } = service([
      { name: "agents", accounts: { listAccounts, resolve: async () => null } },
      { name: "discord", accounts: null },
    ]);

    expect(await channelsService.accounts("agents", { query: "atlas" })).toEqual([
      { name: "atlas (dot)", addresses: ["a1"] },
    ]);
    expect(listAccounts).toHaveBeenCalledWith({ query: "atlas", limit: 20 });
    await expect(channelsService.accounts("discord")).rejects.toThrow(
      'Channel "discord" has no address book',
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
    expect(JSON.parse(JSON.stringify(summary))).toEqual({ name: "discord", sendable: true });
  });
});
