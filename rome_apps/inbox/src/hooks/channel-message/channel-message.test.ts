import { beforeEach, describe, expect, it, rs } from "@rstest/core";
import type {
  ActionEngineLike,
  ConversationId,
  ConversationSettingsControl,
  InboundMessage,
  TalkFeatureMap,
  TalkFeatureName,
  TalkRouter,
} from "@rome-os/app-runtime";
import { ChannelMessageHook } from "./index.js";

const TELEGRAM_ID = "connection:telegram";
const WHATSAPP_ID = "connection:whatsapp";

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: "message-1",
    conversationId: "chat-1" as ConversationId,
    senderId: "user-1",
    senderDisplayName: "Alice",
    text: "Hello team",
    attachments: [],
    timestamp: new Date("2026-01-20T12:00:00Z"),
    thread: { kind: "group", name: "Dev Chat" },
    ...overrides,
  };
}

function snapshot(
  connectionId: string,
  conversationId: ConversationId,
  overrides: { enabled?: boolean; agentName?: string | null } = {},
) {
  return {
    conversation: {
      ref: { connectionId, conversationId },
      service: connectionId === TELEGRAM_ID ? "telegram" : "whatsapp",
      kind: "group" as const,
      displayName: conversationId,
    },
    supportedFields: [],
    effective: {
      enabled: overrides.enabled ?? true,
      activation: {
        mode: "all" as const,
        botMessages: "ignore" as const,
        whenOthersMentioned: "ignore" as const,
      },
      replies: { placement: "inline" as const },
      routing: { agentName: overrides.agentName ?? null },
      session: { reset: { mode: "idle" as const, idleMinutes: 10_080 } },
    },
    overrides: {},
  };
}

function createHarness() {
  const handlers = new Map<string, (message: InboundMessage) => Promise<void>>();
  const features = new Map<string, Partial<TalkFeatureMap>>();
  const run = rs.fn(async () => ({ status: "ok" as const }));
  const actionEngine = { run } as unknown as ActionEngineLike;
  const get = rs.fn(async ({ connectionId, conversationId }) =>
    snapshot(connectionId, conversationId),
  );
  const conversationSettings = { get } as unknown as ConversationSettingsControl;
  const talkRouter: TalkRouter = {
    list: async () => [
      { connectionId: TELEGRAM_ID, service: "telegram" },
      { connectionId: WHATSAPP_ID, service: "whatsapp" },
    ],
    subscribe: (connectionId, handler) => {
      handlers.set(connectionId, handler);
      return () => handlers.delete(connectionId);
    },
    async send(_connectionId, conversationId) {
      return { conversationId };
    },
    feature<K extends TalkFeatureName>(connectionId: string, name: K) {
      return (features.get(connectionId)?.[name] ?? null) as TalkFeatureMap[K] | null;
    },
  };
  const hook = new ChannelMessageHook(actionEngine, talkRouter, conversationSettings);
  const emit = async (connectionId: string, incoming: InboundMessage) => {
    const handler = handlers.get(connectionId);
    if (!handler) throw new Error(`no subscription for ${connectionId}`);
    await handler(incoming);
  };

  return { hook, run, get, features, emit };
}

describe("ChannelMessageHook", () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(async () => {
    harness = createHarness();
    await harness.hook.register();
  });

  it("subscribes once and dispatches connection-scoped messages", async () => {
    await harness.hook.register();
    await harness.emit(
      TELEGRAM_ID,
      message({
        messageId: "tg-100",
        conversationId: "thread-1" as ConversationId,
        parentConversationId: "group-1" as ConversationId,
        thread: { kind: "topic", name: "Dev thread" },
        attachments: [{ type: "image", url: "file-id-1", caption: "pic" }],
        replyTo: { messageId: "tg-99", content: "Earlier message", senderName: "Bob" },
      }),
    );

    expect(harness.run).toHaveBeenCalledTimes(1);
    expect(harness.run).toHaveBeenCalledWith(
      "message_handler",
      expect.objectContaining({
        connectionId: TELEGRAM_ID,
        channel: "telegram",
        channelUserId: "user-1",
        threadId: "thread-1",
        parentThreadId: "group-1",
        text: "Hello team",
        timestamp: "2026-01-20T12:00:00.000Z",
        messageId: "tg-100",
      }),
      expect.objectContaining({
        initiator: `connection:${TELEGRAM_ID}`,
        channelContext: expect.objectContaining({
          connectionId: TELEGRAM_ID,
          channel: "telegram",
          threadId: "thread-1",
          parentThreadId: "group-1",
        }),
      }),
    );
  });

  it("honors disabled conversations and routed agents from shared settings", async () => {
    harness.get.mockImplementation(async ({ connectionId, conversationId }) =>
      snapshot(connectionId, conversationId, { enabled: false }),
    );
    await harness.emit(TELEGRAM_ID, message());
    expect(harness.run).not.toHaveBeenCalled();

    harness.get.mockImplementation(async ({ connectionId, conversationId }) =>
      snapshot(connectionId, conversationId, { agentName: "envoy" }),
    );
    await harness.emit(TELEGRAM_ID, message({ messageId: "routed" }));
    expect(harness.run).toHaveBeenCalledWith(
      "message_handler",
      expect.objectContaining({ routedAgentName: "envoy" }),
      expect.anything(),
    );
  });

  it("materializes attachments through the inboundMedia feature", async () => {
    const materialize = rs.fn(async () => [
      { type: "image" as const, url: "file-id", localPath: "/tmp/photo.jpg" },
    ]);
    harness.features.set(TELEGRAM_ID, { inboundMedia: { materialize } });
    const incoming = message({ text: "", attachments: [{ type: "image", url: "file-id" }] });

    await harness.emit(TELEGRAM_ID, incoming);

    expect(materialize).toHaveBeenCalledWith(incoming);
    expect(harness.run).toHaveBeenCalledWith(
      "message_handler",
      expect.objectContaining({
        attachments: [{ type: "image", url: "file-id", localPath: "/tmp/photo.jpg" }],
      }),
      expect.anything(),
    );
  });

  it("finishes activity as done after successful handling", async () => {
    let finishRun!: () => void;
    harness.run.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishRun = () => resolve({ status: "ok" });
        }),
    );
    const update = rs.fn(async () => undefined);
    const finish = rs.fn(async () => undefined);
    const begin = rs.fn(async () => ({ update, finish }));
    harness.features.set(TELEGRAM_ID, { activity: { begin } });

    const handling = harness.emit(TELEGRAM_ID, message({ messageId: "processing" }));
    await rs.waitFor(() => expect(update).toHaveBeenCalledWith("thinking"));
    expect(finish).not.toHaveBeenCalled();
    finishRun();
    await handling;
    await rs.waitFor(() => expect(finish).toHaveBeenCalledWith("done"));
  });

  it("finishes activity as error when handling fails", async () => {
    harness.run.mockRejectedValue(new Error("handler failed"));
    const finish = rs.fn(async () => undefined);
    harness.features.set(TELEGRAM_ID, {
      activity: { begin: rs.fn(async () => ({ update: rs.fn(), finish })) },
    });

    await harness.emit(TELEGRAM_ID, message());

    await rs.waitFor(() => expect(finish).toHaveBeenCalledWith("error"));
  });

  it("does not block dispatch when cosmetic activity feedback stalls", async () => {
    harness.features.set(TELEGRAM_ID, {
      activity: { begin: rs.fn(() => new Promise(() => {})) },
    });

    await harness.emit(TELEGRAM_ID, message());

    expect(harness.run).toHaveBeenCalledTimes(1);
  });

  it("skips empty messages and handles connections independently", async () => {
    await harness.emit(TELEGRAM_ID, message({ text: "   ", attachments: [] }));
    expect(harness.run).not.toHaveBeenCalled();

    await harness.emit(TELEGRAM_ID, message({ text: "from telegram" }));
    await harness.emit(
      WHATSAPP_ID,
      message({ conversationId: "dm-1" as ConversationId, text: "from whatsapp" }),
    );

    expect(harness.run).toHaveBeenCalledTimes(2);
    expect(harness.run.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ channel: "telegram", connectionId: TELEGRAM_ID }),
    );
    expect(harness.run.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ channel: "whatsapp", connectionId: WHATSAPP_ID }),
    );
  });

  it("unregister detaches every subscription and a fresh register resubscribes", async () => {
    harness.hook.unregister();

    await expect(harness.emit(TELEGRAM_ID, message())).rejects.toThrow("no subscription");
    await expect(harness.emit(WHATSAPP_ID, message())).rejects.toThrow("no subscription");

    // The host swaps in a replacement after an app-keys change; register() on
    // the (here: same) instance must resubscribe everything talkRouter lists.
    await harness.hook.register();
    await harness.emit(TELEGRAM_ID, message({ text: "after reload" }));
    expect(harness.run).toHaveBeenCalledTimes(1);
  });
});
