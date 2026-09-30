import { describe, expect, it, rs } from "@rstest/core";
import type {
  ChannelMessage,
  ChannelsService,
  ConversationId,
  MessageReceipt,
} from "@rome-os/app-runtime";
import type { Channels } from "./channel.js";
import { createChannelsService, sendApprovalCard } from "./channels-service.js";

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

type Feature = (connectionId: string, name: string) => unknown;

function service(channels: unknown[] = [], feature = rs.fn<Feature>(() => null)) {
  const send = rs.fn<ChannelsService["send"]>(async () => RECEIPT);
  const channelsService = createChannelsService({
    channels: () => channels as Channels,
    router: { list: async () => CONNECTIONS, send, feature: feature as never },
  });
  return { channelsService, send, feature };
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

  it("reads history from the chosen Connection for a channel with no store", async () => {
    const history = { query: rs.fn(async () => [line("live", 1_000)]) };
    const feature = rs.fn<Feature>(() => history);
    const { channelsService } = service([{ name: "telegram_user", messages: null }], feature);
    const since = new Date(0);

    const page = await channelsService.history("telegram_user", {
      connectionId: "tg-b",
      conversationId: "c1" as ConversationId,
      since,
    });

    expect(page.map((m) => m.messageId)).toEqual(["live"]);
    expect(feature).toHaveBeenCalledWith("tg-b", "history");
    expect(history.query).toHaveBeenCalledWith({ conversationId: "c1", since });
  });

  it("reads history from a store oldest first", async () => {
    const query = rs.fn(async () => [line("newer", 2_000), line("older", 1_000)]);
    const { channelsService } = service([
      { name: "whatsapp", messages: { query, byAccount: null } },
    ]);
    const withWhatsApp = createChannelsService({
      channels: () => [{ name: "whatsapp", messages: { query, byAccount: null } }] as never,
      router: {
        list: async () => [{ connectionId: "wa-1", service: "whatsapp" }],
        send: rs.fn() as never,
        feature: rs.fn(() => null) as never,
      },
    });

    const page = await withWhatsApp.history("whatsapp", {});

    expect(page.map((m) => m.messageId)).toEqual(["older", "newer"]);
    await expect(channelsService.history("whatsapp", {})).rejects.toThrow(
      'No Talk connection registered for "whatsapp"',
    );
  });
});

describe("sendApprovalCard", () => {
  const approval = {
    approvalId: "ap-1",
    actionName: "send_email",
    preview: undefined,
  };

  function channels(connectionIds: string[]) {
    return {
      list: async () => [{ name: "telegram_user", connectionIds }],
      send: rs.fn<ChannelsService["send"]>(async () => RECEIPT),
    };
  }

  it("puts the card in the conversation the approval came from", async () => {
    const target = channels(["tg-a", "tg-b"]);

    await sendApprovalCard(target, {
      ...approval,
      channelContext: { channel: "telegram_user", threadId: "t1", connectionId: "tg-b" },
    } as never);

    expect(target.send).toHaveBeenCalledWith(
      "telegram_user",
      "t1",
      {
        parts: [
          {
            type: "approval_card",
            approvalId: "ap-1",
            actionName: "send_email",
            preview: {
              kind: "generic",
              title: "send_email",
              summary: 'The agent wants to run "send_email" and needs your approval.',
            },
            status: "pending",
          },
        ],
      },
      { connectionId: "tg-b" },
    );
  });

  it("falls back to the channel's only Connection", async () => {
    const target = channels(["tg-a"]);

    await sendApprovalCard(target, {
      ...approval,
      channelContext: { channel: "telegram_user", threadId: "t1" },
    } as never);

    expect(target.send.mock.calls[0]?.[3]).toEqual({ connectionId: "tg-a" });
  });

  it("sends nothing without a conversation or a Connection it can tell", async () => {
    const target = channels(["tg-a", "tg-b"]);

    await sendApprovalCard(target, approval as never);
    await sendApprovalCard(target, {
      ...approval,
      channelContext: { channel: "telegram_user", threadId: "t1" },
    } as never);

    expect(target.send).not.toHaveBeenCalled();
  });
});
