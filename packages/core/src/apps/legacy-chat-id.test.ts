import { describe, expect, it, rs } from "@rstest/core";
import type {
  Channel,
  ChannelMessage,
  ChannelsService,
  ChatId,
  ChatRef,
  ChatSettingsControl,
  ChatSettingsSnapshot,
  ChatStopHandler,
  InboundEvent,
} from "@rome-os/app-runtime";
import {
  legacyChatIdChannels,
  legacyChatIdChannelsService,
  legacyChatIdSettings,
  legacyChatIdSettingsChange,
  legacyChatIdStop,
} from "./legacy-chat-id.js";

const CHAT = "chat-1" as ChatId;
const ref: ChatRef = { connectionId: "conn-1", chatId: CHAT };

const message: ChannelMessage = {
  channel: "telegram",
  direction: "inbound",
  messageId: "m1",
  chatId: CHAT,
  parentChatId: "parent-1" as ChatId,
  senderId: "u1",
  text: "hi",
  attachments: [],
  timestamp: new Date(0),
};

const snapshot = {
  conversation: { ref, service: "telegram", kind: "dm", displayName: "Ann" },
  supportedFields: [],
  effective: {},
  overrides: {},
} as unknown as ChatSettingsSnapshot;

/** What an app written for SDK 0.7 reads off a value. */
const legacy = (value: unknown) =>
  value as { conversationId?: string; parentConversationId?: string };

describe("chat ids for apps written for SDK 0.7", () => {
  it("names each chat in a settings snapshot under both names", async () => {
    const control = legacyChatIdSettings({
      get: async () => snapshot,
      list: async () => ({ items: [] }),
      update: async () => snapshot,
      reset: async () => snapshot,
    });

    const read = await control.get(ref);

    expect(read.conversation.ref.chatId).toBe(CHAT);
    expect(legacy(read.conversation.ref).conversationId).toBe(CHAT);
  });

  it("reads a ref an app names only by conversationId", async () => {
    const get = rs.fn<ChatSettingsControl["get"]>(async () => snapshot);
    const control = legacyChatIdSettings({
      get,
      list: async () => ({ items: [] }),
      update: async () => snapshot,
      reset: async () => snapshot,
    });

    await control.get({ connectionId: "conn-1", conversationId: CHAT } as unknown as ChatRef);

    expect(get).toHaveBeenCalledWith(expect.objectContaining({ chatId: CHAT }));
  });

  it("answers a read and a send with both names, and reads a query under either", async () => {
    const query = rs.fn<ChannelsService["query"]>(async () => [message]);
    const service = legacyChatIdChannelsService({
      list: async () => [],
      send: async () => ({ chatId: CHAT, messageId: "m2" }),
      query,
    });

    const [read] = await service.query("telegram", {
      conversationId: CHAT,
    } as unknown as Parameters<ChannelsService["query"]>[1]);
    const receipt = await service.send("telegram", CHAT, { text: "hi" });

    // The worker RPC rejects a key it does not know, so the old name stays behind.
    expect(query).toHaveBeenCalledWith("telegram", { chatId: CHAT });
    expect(legacy(read)).toMatchObject({ conversationId: CHAT, parentConversationId: "parent-1" });
    expect(legacy(receipt).conversationId).toBe(CHAT);
  });

  it("delivers a hook's events and receipts with both names", async () => {
    let deliver: ((event: InboundEvent) => Promise<void>) | undefined;
    const channel: Channel = {
      name: "telegram",
      send: { send: async () => ({ chatId: CHAT }) },
      inbound: {
        subscribe: (handler) => {
          deliver = handler;
          return () => {};
        },
        media: null,
      },
    };
    const [wrapped] = legacyChatIdChannels([channel]);
    const heard: InboundEvent[] = [];
    wrapped?.inbound?.subscribe(async (event) => {
      heard.push(event);
    });

    await deliver?.({ kind: "message", message, ref });
    const receipt = await wrapped?.send?.send(CHAT, { text: "hi" });

    expect(legacy(heard[0]?.message).conversationId).toBe(CHAT);
    expect(legacy(heard[0]?.ref).conversationId).toBe(CHAT);
    expect(legacy(receipt).conversationId).toBe(CHAT);
  });

  it("stops the turn of a chat a hook names only by conversationId", async () => {
    const stop = rs.fn<ChatStopHandler>(async () => ({ status: "idle" }));

    await legacyChatIdStop(stop)({
      ref: { connectionId: "conn-1", conversationId: CHAT } as unknown as ChatRef,
      service: "telegram",
      senderId: "u1",
    });

    expect(stop).toHaveBeenCalledWith(
      expect.objectContaining({ ref: { connectionId: "conn-1", chatId: CHAT } }),
    );
  });

  it("materializes media for a message a hook names only by conversationId", async () => {
    const materialize = rs.fn(async (_message: ChannelMessage) => []);
    const channel: Channel = {
      name: "telegram",
      send: null,
      inbound: { subscribe: () => () => {}, media: { materialize } },
    };
    const [wrapped] = legacyChatIdChannels([channel]);
    const { chatId: _chatId, parentChatId: _parentChatId, ...rest } = message;

    await wrapped?.inbound?.media?.materialize({
      ...rest,
      conversationId: CHAT,
      parentConversationId: "parent-1",
    } as unknown as ChannelMessage);

    const [forwarded] = materialize.mock.calls[0] ?? [];
    expect(forwarded).toMatchObject({ chatId: CHAT, parentChatId: "parent-1" });
    expect(legacy(forwarded).conversationId).toBeUndefined();
  });

  it("publishes a settings change a routine can filter by conversationId", () => {
    const payload = legacyChatIdSettingsChange({ ref, fields: ["enabled"], reset: false });

    expect(payload.ref.chatId).toBe(CHAT);
    expect(legacy(payload.ref).conversationId).toBe(CHAT);
  });
});
