import { beforeEach, describe, expect, it, rs } from "@rstest/core";
import type {
  ActionEngineLike,
  Channel,
  ChatStopHandler,
  ConversationId,
  ConversationSettingsControl,
  ChannelMessage,
  InboundEvent,
  ChannelActivity,
  ChannelInboundMedia,
} from "@rome-os/app-runtime";
import { ChannelMessageHook, createHook, MissingChannelsError } from "./index.js";

const TELEGRAM_ID = "connection:telegram";
const WHATSAPP_ID = "connection:whatsapp";
const AGENTS_ID = "connection:agents";
const FEISHU_2_ID = "connection:feishu-2";
const SERVICES: Record<string, string> = {
  [TELEGRAM_ID]: "telegram",
  [WHATSAPP_ID]: "whatsapp",
  [AGENTS_ID]: "agents",
  [FEISHU_2_ID]: "feishu",
};

// What a channel's port reads for activity and inbound media, per Connection.
interface ChannelFeatures {
  activity: ChannelActivity;
  inboundMedia: ChannelInboundMedia;
}

function message(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    channel: "telegram",
    direction: "inbound",
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
      service: SERVICES[connectionId] ?? "unknown",
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

function createHarness(options: ConstructorParameters<typeof ChannelMessageHook>[4] = {}) {
  const handlers = new Map<string, (event: InboundEvent) => Promise<void>>();
  const features = new Map<string, Partial<ChannelFeatures>>();
  const run = rs.fn(async () => ({ status: "ok" as const }));
  const actionEngine = { run } as unknown as ActionEngineLike;
  const get = rs.fn(async ({ connectionId, conversationId }) =>
    snapshot(connectionId, conversationId),
  );
  const conversationSettings = { get } as unknown as ConversationSettingsControl;
  const stop = rs.fn(async () => ({ status: "stop_requested" as const, turnId: "turn-1" }));
  const chatStop: ChatStopHandler = stop;
  const send = rs.fn(
    async (_connectionId: string, conversationId: ConversationId, _outgoing?: unknown) => ({
      conversationId,
    }),
  );
  const feature = <K extends keyof ChannelFeatures>(connectionId: string, name: K) =>
    (features.get(connectionId)?.[name] ?? null) as ChannelFeatures[K] | null;
  // One channel per Connection, as the channel list builds them.
  const subscribes = rs.fn((_name: string) => undefined);
  const channel = (name: string, connectionId: string): Channel => ({
    name,
    send: {
      send: (conversationId, outgoing) => send(connectionId, conversationId, outgoing),
      get activity() {
        return feature(connectionId, "activity");
      },
    },
    inbound: {
      subscribe: (handler) => {
        subscribes(name);
        handlers.set(connectionId, handler);
        return () => handlers.delete(connectionId);
      },
      get media() {
        return feature(connectionId, "inboundMedia");
      },
    },
  });
  const channels: Channel[] = [
    channel("telegram", TELEGRAM_ID),
    channel("whatsapp", WHATSAPP_ID),
    channel("agents", AGENTS_ID),
  ];
  const hook = new ChannelMessageHook(
    actionEngine,
    conversationSettings,
    chatStop,
    channels,
    options,
  );
  // A conversation's events reach the handler one at a time, each after the
  // previous one settles, as rule R4 of `ChannelInbound` requires of a channel.
  const tails = new Map<string, Promise<void>>();
  const emit = (connectionId: string, incoming: ChannelMessage): Promise<void> => {
    const handler = handlers.get(connectionId);
    if (!handler) return Promise.reject(new Error(`no subscription for ${connectionId}`));
    const key = `${connectionId}:${incoming.conversationId}`;
    const handled = (tails.get(key) ?? Promise.resolve()).then(() =>
      handler({
        kind: "message",
        message: incoming,
        ref: { connectionId, conversationId: incoming.conversationId },
      }),
    );
    tails.set(
      key,
      handled.catch(() => {}),
    );
    return handled;
  };

  return { hook, run, get, features, emit, stop, send, channels, channel, subscribes };
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

  it("handles a direct /stop before settings or message_handler", async () => {
    await harness.emit(
      TELEGRAM_ID,
      message({ text: "/STOP", thread: { kind: "dm", name: "Alice" } }),
    );

    expect(harness.stop).toHaveBeenCalledWith({
      ref: { connectionId: TELEGRAM_ID, conversationId: "chat-1" },
      service: "telegram",
      senderId: "user-1",
    });
    expect(harness.send).toHaveBeenCalledWith(TELEGRAM_ID, "chat-1", {
      text: "Stopped.",
    });
    expect(harness.get).not.toHaveBeenCalled();
    expect(harness.run).not.toHaveBeenCalled();
  });

  it("accepts an addressed group /stop even when the conversation is disabled", async () => {
    harness.get.mockImplementation(async ({ connectionId, conversationId }) =>
      snapshot(connectionId, conversationId, { enabled: false }),
    );

    await harness.emit(
      TELEGRAM_ID,
      message({ text: "/stop", addressing: "mention", thread: { kind: "group" } }),
    );

    expect(harness.stop).toHaveBeenCalledTimes(1);
    expect(harness.get).not.toHaveBeenCalled();
    expect(harness.run).not.toHaveBeenCalled();
  });

  it("swallows an ambient group /stop instead of sending it to the model", async () => {
    await harness.emit(
      TELEGRAM_ID,
      message({ text: "/stop", addressing: "ambient", thread: { kind: "group" } }),
    );

    expect(harness.stop).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.run).not.toHaveBeenCalled();
  });

  it("hands an agent's /stop to message_handler as text, without stopping or answering", async () => {
    const agentId = "7d3f6a52-1c8e-4b2a-9f0d-5e6a7b8c9d01";
    await harness.emit(
      AGENTS_ID,
      message({
        channel: "agents",
        senderId: agentId,
        conversationId: agentId as ConversationId,
        senderDisplayName: "Atlas",
        text: "/stop",
        thread: { kind: "dm" },
      }),
    );

    expect(harness.stop).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.get).toHaveBeenCalledWith({ connectionId: AGENTS_ID, conversationId: agentId });
    expect(harness.run).toHaveBeenCalledWith(
      "message_handler",
      expect.objectContaining({
        connectionId: AGENTS_ID,
        channel: "agents",
        channelUserId: agentId,
        text: "/stop",
      }),
      expect.anything(),
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
    // the (here: same) instance must resubscribe every channel that receives.
    await harness.hook.register();
    await harness.emit(TELEGRAM_ID, message({ text: "after reload" }));
    expect(harness.run).toHaveBeenCalledTimes(1);
  });
  it("hears a /stop in a chat whose turn is still running", async () => {
    harness.run.mockImplementationOnce(() => new Promise(() => {}));

    // The turn never finishes; the conversation is still free for the next
    // message once the turn is dispatched.
    await harness.emit(TELEGRAM_ID, message({ messageId: "long turn" }));
    await harness.emit(
      TELEGRAM_ID,
      message({ messageId: "stop", text: "/stop", thread: { kind: "dm" } }),
    );

    expect(harness.stop).toHaveBeenCalledTimes(1);
  });
  it("reports a turn still running past the threshold, and not one that finished", async () => {
    const warn = rs.fn();
    const slow = createHarness({ slowTurnMs: 20, log: { warn } });
    await slow.hook.register();
    slow.run.mockImplementationOnce(() => new Promise(() => {}));

    await slow.emit(TELEGRAM_ID, message({ messageId: "hung" }));
    await slow.emit(TELEGRAM_ID, message({ messageId: "quick" }));

    await rs.waitFor(() =>
      expect(warn).toHaveBeenCalledWith("message turn still running", {
        service: "telegram",
        messageId: "hung",
        runningMs: 20,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(warn).toHaveBeenCalledTimes(1);
  });
  it("subscribes to channels the host adds, once each", async () => {
    expect(harness.subscribes.mock.calls.map(([name]) => name)).toEqual([
      "telegram",
      "whatsapp",
      "agents",
    ]);

    const added = harness.channel("feishu-2", FEISHU_2_ID);
    harness.channels.push(added);
    await harness.hook.addChannels([added]);
    await harness.hook.register();

    expect(harness.subscribes.mock.calls.map(([name]) => name)).toEqual([
      "telegram",
      "whatsapp",
      "agents",
      "feishu-2",
    ]);
    await harness.emit(FEISHU_2_ID, message({ channel: "feishu-2" }));
    expect(harness.run).toHaveBeenCalledWith(
      "message_handler",
      expect.objectContaining({ connectionId: FEISHU_2_ID, channel: "feishu-2" }),
      expect.anything(),
    );

    harness.hook.unregister();
    await expect(harness.emit(FEISHU_2_ID, message())).rejects.toThrow("no subscription");
    await harness.hook.register();
    expect(harness.subscribes).toHaveBeenCalledTimes(8);
  });

  describe("on accounts that take a linked agent", () => {
    // feishu-2 takes a link, and telegram stands for a channel that takes none.
    let linked: string | null;
    const linkedAgentOf = rs.fn((name: string) => (name === "feishu-2" ? linked : undefined));

    beforeEach(async () => {
      linked = "sales:agent";
      linkedAgentOf.mockClear();
      harness = createHarness({ linkedAgentOf });
      harness.channels.push(harness.channel("feishu-2", FEISHU_2_ID));
      await harness.hook.register();
      harness.get.mockImplementation(async ({ connectionId, conversationId }) =>
        snapshot(connectionId, conversationId, { agentName: "override" }),
      );
    });

    const passed = (fields: Record<string, unknown>) => [
      "message_handler",
      expect.objectContaining(fields),
      expect.anything(),
    ];

    it("passes the linked agent read per message, with the group's choice", async () => {
      await harness.emit(FEISHU_2_ID, message({ messageId: "m-1" }));
      linked = "support:agent";
      await harness.emit(FEISHU_2_ID, message({ messageId: "m-2" }));
      await harness.emit(TELEGRAM_ID, message({ messageId: "m-3" }));

      expect(harness.run).toHaveBeenNthCalledWith(
        1,
        ...passed({ linkedAgentName: "sales:agent", routedAgentName: "override" }),
      );
      expect(harness.run).toHaveBeenNthCalledWith(
        2,
        ...passed({ linkedAgentName: "support:agent", routedAgentName: "override" }),
      );
      expect(harness.run).toHaveBeenNthCalledWith(
        3,
        ...passed({ linkedAgentName: undefined, routedAgentName: "override" }),
      );
      expect(linkedAgentOf).toHaveBeenCalledWith("feishu-2");
    });

    it("passes a group's explicit pin to main as its choice", async () => {
      harness.get.mockImplementation(async ({ connectionId, conversationId }) => ({
        ...snapshot(connectionId, conversationId),
        overrides: { routing: { agentName: null } },
      }));

      await harness.emit(FEISHU_2_ID, message());

      expect(harness.run).toHaveBeenCalledWith(
        ...passed({ linkedAgentName: "sales:agent", routedAgentName: "core:main" }),
      );
    });

    it("answers nothing on an account with no linked agent", async () => {
      linked = null;

      await harness.emit(FEISHU_2_ID, message({ messageId: "m-1" }));

      expect(harness.run).not.toHaveBeenCalled();
      expect(harness.get).not.toHaveBeenCalled();
      expect(harness.send).not.toHaveBeenCalled();

      linked = "sales:agent";
      await harness.emit(FEISHU_2_ID, message({ messageId: "m-2" }));
      expect(harness.run).toHaveBeenCalledWith(
        ...passed({ channel: "feishu-2", linkedAgentName: "sales:agent" }),
      );
    });

    it("still stops a running turn on an account that is now unlinked", async () => {
      linked = null;

      await harness.emit(
        FEISHU_2_ID,
        message({ messageId: "stop", text: "/stop", thread: { kind: "dm" } }),
      );

      expect(harness.stop).toHaveBeenCalledTimes(1);
      expect(harness.run).not.toHaveBeenCalled();
    });
  });

  it("reads every channel as taking no link on a host that passes no linkedAgentOf", async () => {
    const hook = createHook({
      actionEngine: { run: harness.run } as unknown as ActionEngineLike,
      conversationSettings: { get: harness.get } as unknown as ConversationSettingsControl,
      chatStop: harness.stop,
      channels: harness.channels,
    });
    harness.hook.unregister();
    await hook.register();

    await harness.emit(TELEGRAM_ID, message());

    expect(harness.run).toHaveBeenCalledWith(
      "message_handler",
      expect.objectContaining({ channel: "telegram", linkedAgentName: undefined }),
      expect.anything(),
    );
  });

  it("refuses, by name, a host that passes no channels", () => {
    expect(() =>
      createHook({
        actionEngine: {} as ActionEngineLike,
        conversationSettings: {} as ConversationSettingsControl,
        chatStop: async () => ({ status: "idle" }),
      } as unknown as Parameters<typeof createHook>[0]),
    ).toThrow(MissingChannelsError);
  });
});
