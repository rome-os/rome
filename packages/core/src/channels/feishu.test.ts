import { describe, it, expect, beforeEach, rs } from "@rstest/core";
import type {
  ChannelMessage,
  ConversationDescriptor,
  ConversationId,
  ConversationSettings,
  ConversationSettingsControl,
  ConversationSettingsOverrides,
  ConversationSettingsSnapshot,
} from "@rome-os/app-runtime";
import type {
  CardActionEvent,
  LarkChannel,
  NormalizedMessage as LarkMessage,
  SendInput,
  SendOptions,
} from "@larksuiteoapi/node-sdk";
import type { PersonMappingRepository } from "../db/repositories/person-mapping.js";
import { LarkChannelError } from "@larksuiteoapi/node-sdk";
import { FeishuAdapter, historyItemText, isFeishuAuthError, resolveMentions } from "./feishu.js";

// The official SDK's LarkChannel is the process edge here, played by a fake
// through the adapter's createChannel seam. The fake captures the registered
// `message` handler so a test can replay a normalized inbound event, and records
// outbound `send` calls — exercising the adapter's mapping, not the SDK.

class FakeLarkChannel {
  handlers = new Map<string, (arg: unknown) => unknown>();
  sent: Array<{ to: string; input: SendInput; opts?: SendOptions }> = [];
  updatedCards: Array<{ messageId: string; card: object }> = [];
  addedReactions: Array<{ messageId: string; emojiType: string; reactionId: string }> = [];
  removedReactions: Array<{ messageId: string; reactionId: string }> = [];
  connected = false;
  botIdentity = { openId: "ou_bot", name: "Rome" };
  /** Pages `im.v1.message.list` answers, newest first, one per call in turn. */
  historyPages: Array<{ items: HistoryItem[]; has_more?: boolean; page_token?: string }> = [];
  historyCalls: Array<Record<string, unknown>> = [];
  rawClient = {
    im: {
      v1: {
        message: {
          list: async (payload: { params: Record<string, unknown> }) => {
            this.historyCalls.push(payload.params);
            const page = this.historyPages[this.historyCalls.length - 1] ?? { items: [] };
            return { code: 0, data: page };
          },
        },
      },
    },
  };

  on(name: string, handler: (arg: unknown) => unknown): () => void {
    this.handlers.set(name, handler);
    return () => this.handlers.delete(name);
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async send(to: string, input: SendInput, opts?: SendOptions) {
    this.sent.push({ to, input, opts });
    return { messageId: "om_sent" };
  }

  async updateCard(messageId: string, card: object) {
    this.updatedCards.push({ messageId, card });
  }

  async addReaction(messageId: string, emojiType: string): Promise<string> {
    const reactionId = `reaction-${this.addedReactions.length + 1}`;
    this.addedReactions.push({ messageId, emojiType, reactionId });
    return reactionId;
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    this.removedReactions.push({ messageId, reactionId });
  }

  /** Replay an inbound normalized message through the registered handler. */
  async emit(msg: Partial<LarkMessage>): Promise<void> {
    const handler = this.handlers.get("message");
    if (!handler) throw new Error("no message handler registered");
    await handler(makeMessage(msg));
  }

  async emitCardAction(evt: Partial<CardActionEvent>): Promise<void> {
    const handler = this.handlers.get("cardAction");
    if (!handler) throw new Error("no cardAction handler registered");
    await handler(makeCardAction(evt));
  }

  emitError(err: unknown): void {
    const handler = this.handlers.get("error");
    if (!handler) throw new Error("no error handler registered");
    (handler as (e: unknown) => void)(err);
  }
}

interface HistoryItem {
  message_id?: string;
  msg_type?: string;
  create_time?: string;
  deleted?: boolean;
  parent_id?: string;
  sender?: { id: string; id_type: string; sender_type: string; sender_name?: string };
  body?: { content: string };
  mentions?: Array<{ key: string; id: string; id_type: string; name: string }>;
}

function historyItem(over: Partial<HistoryItem> = {}): HistoryItem {
  return {
    message_id: "om_h1",
    msg_type: "text",
    create_time: "1700000000000",
    // `message.list` leaves `sender_name` out unless Feishu chooses to send it.
    sender: { id: "ou_alice", id_type: "open_id", sender_type: "user" },
    body: { content: JSON.stringify({ text: "the client wants a volume discount" }) },
    ...over,
  };
}

function makeMessage(over: Partial<LarkMessage> = {}): LarkMessage {
  return {
    messageId: "om_123",
    chatId: "oc_chat",
    chatType: "p2p",
    senderId: "ou_alice",
    senderName: "Alice",
    content: "hello",
    rawContentType: "text",
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: 1700000000000,
    ...over,
  };
}

function makeCardAction(over: Partial<CardActionEvent> = {}): CardActionEvent {
  return {
    messageId: "om_card",
    chatId: "oc_chat",
    operator: { openId: "ou_alice", name: "Alice" },
    action: {
      tag: "button",
      value: { action: "configure_feishu_group", op: "save" },
    },
    raw: {
      action: {
        value: { action: "configure_feishu_group", op: "save" },
        form_value: {},
      },
    },
    ...over,
  };
}

const FEISHU_CONNECTION_ID = "connection:feishu";

function makeConversationSettings(initial: ConversationSettingsOverrides = {}) {
  const defaults: ConversationSettings = {
    enabled: true,
    activation: {
      mode: "mention",
      botMessages: "ignore",
      whenOthersMentioned: "ignore",
    },
    replies: { placement: "thread" },
    routing: { agentName: null },
    session: { reset: { mode: "idle", idleMinutes: 10_080 } },
  };
  let effective: ConversationSettings = {
    ...defaults,
    ...initial,
    activation: { ...defaults.activation, ...initial.activation },
    replies: { ...defaults.replies, ...initial.replies },
    routing: { ...defaults.routing, ...initial.routing },
    session: { ...defaults.session, ...initial.session },
  };
  const descriptors = new Map<string, ConversationDescriptor>();
  const observe = rs.fn((descriptor: ConversationDescriptor) => {
    descriptors.set(descriptor.ref.conversationId, descriptor);
  });
  const makeSnapshot = (conversationId: ConversationId): ConversationSettingsSnapshot => ({
    conversation:
      descriptors.get(conversationId) ??
      ({
        ref: { connectionId: FEISHU_CONNECTION_ID, conversationId },
        service: "feishu",
        kind: "group",
        displayName: conversationId,
      } satisfies ConversationDescriptor),
    supportedFields: ["enabled", "activation.mode", "replies.placement", "routing.agentName"],
    effective: structuredClone(effective),
    overrides: {},
  });
  const get = rs.fn(async (ref: { conversationId: ConversationId }) =>
    makeSnapshot(ref.conversationId),
  );
  const update = rs.fn(async (input: Parameters<ConversationSettingsControl["update"]>[0]) => {
    for (const field of input.clear) {
      if (field === "enabled") effective.enabled = defaults.enabled;
      if (field === "activation.mode") effective.activation.mode = defaults.activation.mode;
      if (field === "replies.placement") effective.replies.placement = defaults.replies.placement;
      if (field === "routing.agentName") effective.routing.agentName = defaults.routing.agentName;
    }
    if (input.set.enabled !== undefined) effective.enabled = input.set.enabled;
    if (input.set.activation?.mode !== undefined) {
      effective.activation.mode = input.set.activation.mode;
    }
    if (input.set.replies?.placement !== undefined) {
      effective.replies.placement = input.set.replies.placement;
    }
    if (input.set.routing?.agentName !== undefined) {
      effective.routing.agentName = input.set.routing.agentName;
    }
    return makeSnapshot(input.ref.conversationId);
  });
  const reset = rs.fn(async (input: Parameters<ConversationSettingsControl["reset"]>[0]) => {
    effective = structuredClone(defaults);
    return makeSnapshot(input.ref.conversationId);
  });
  const control = {
    observe,
    get,
    update,
    reset,
    list: rs.fn(),
  } as unknown as ConversationSettingsControl & {
    observe(descriptor: ConversationDescriptor): void;
  };
  return { control, get, update, reset, current: () => structuredClone(effective) };
}

function guardianPersonRepo(channelUserId: string): PersonMappingRepository {
  return {
    findByChannelUser: async (channelName: string, userId: string) =>
      channelName === "feishu" && userId === channelUserId
        ? {
            id: "guardian",
            displayName: "Guardian",
            bondLevel: "guardian",
            channelMappings: [{ channel: "feishu", channelUserId }],
          }
        : null,
    findByBondLevel: async () => [
      {
        id: "guardian",
        displayName: "Guardian",
        bondLevel: "guardian",
        channelMappings: [],
      },
    ],
    addChannelMapping: async () => "mapping-id",
  } as unknown as PersonMappingRepository;
}

describe("FeishuAdapter", () => {
  let channel: FakeLarkChannel;
  let adapter: FeishuAdapter;
  let captured: ChannelMessage[];

  beforeEach(async () => {
    channel = new FakeLarkChannel();
    adapter = new FeishuAdapter(
      { appId: "cli_test", appSecret: "secret" },
      () => channel as unknown as LarkChannel,
    );
    captured = [];
    adapter.onInbound(async (msg) => {
      captured.push(msg);
    });
    await adapter.start();
  });

  it("connects on start", () => {
    expect(channel.connected).toBe(true);
  });

  it("maps an inbound private text message onto a ChannelMessage", async () => {
    const event = makeMessage({ content: "hi there" });
    await channel.emit(event);
    expect(captured).toStrictEqual([
      {
        channel: "feishu",
        direction: "inbound",
        messageId: "om_123",
        conversationId: "oc_chat",
        senderId: "ou_alice",
        senderDisplayName: "Alice",
        text: "hi there",
        attachments: [],
        timestamp: new Date(1700000000000),
        thread: { kind: "dm" },
        addressing: "direct",
        raw: event,
      },
    ]);
  });

  it("maps group chat type to a group thread", async () => {
    await channel.emit({ chatType: "group", mentionedBot: true });
    expect(captured[0].thread).toStrictEqual({ kind: "group" });
    expect(captured[0].addressing).toBe("mention");
  });

  it("carries the replied-to message and a fallback sender name", async () => {
    await channel.emit({ senderName: undefined, replyToMessageId: "om_parent" });
    expect(captured[0].senderDisplayName).toBe("Feishu User");
    expect(captured[0].replyTo).toStrictEqual({ messageId: "om_parent" });
  });

  it("leaves replyTo out when the message replies to nothing", async () => {
    await channel.emit({});
    expect(captured[0]).not.toHaveProperty("replyTo");
  });

  it("normalizes an addressed group /stop without leaving the bot mention in the command", async () => {
    await channel.emit({
      chatType: "group",
      mentionedBot: true,
      content: "@_user_1 /stop",
      mentions: [{ key: "@_user_1", name: "Rome" }],
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ text: "/stop", addressing: "mention" });
  });

  it("preserves an @-only group message as the visible bot mention", async () => {
    await channel.emit({
      chatType: "group",
      content: "",
      rawContentType: "text",
      mentions: [],
      mentionedBot: true,
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ text: "@Rome", addressing: "mention" });
  });

  it("preserves an @-only rich-text post as the visible bot mention", async () => {
    await channel.emit({
      chatType: "group",
      content: "",
      rawContentType: "post",
      mentions: [],
      mentionedBot: true,
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].text).toBe("@Rome");
  });

  it("still drops a media-only message that mentions the bot", async () => {
    await channel.emit({
      chatType: "group",
      content: "",
      rawContentType: "image",
      mentions: [],
      mentionedBot: true,
    });

    expect(captured).toHaveLength(0);
  });

  it("ignores group messages that do not mention the bot by default", async () => {
    await channel.emit({ chatType: "group", mentionedBot: false });
    expect(captured).toHaveLength(0);
  });

  it("sends a group settings card for guardian settings requests", async () => {
    const conversationSettings = makeConversationSettings();
    channel = new FakeLarkChannel();
    adapter = new FeishuAdapter(
      {
        appId: "cli_test",
        appSecret: "secret",
        connectionId: FEISHU_CONNECTION_ID,
        conversationSettings: conversationSettings.control,
        personMappingRepo: guardianPersonRepo("ou_alice"),
      },
      () => channel as unknown as LarkChannel,
    );
    captured = [];
    adapter.onInbound(async (msg) => {
      captured.push(msg);
    });
    await adapter.start();

    await channel.emit({
      chatType: "group",
      mentionedBot: true,
      content: "@_user_1 settings",
      mentions: [{ key: "@_user_1", name: "Rome" }],
    });

    expect(captured).toHaveLength(0);
    expect(channel.sent).toHaveLength(1);
    const inputJson = JSON.stringify(channel.sent[0].input);
    expect(channel.sent[0]).toMatchObject({
      to: "oc_chat",
      input: { card: { header: { title: { content: "Rome group settings" } } } },
      opts: { replyTo: "om_123" },
    });
    expect(inputJson).toContain("select_static");
    expect(inputJson).toContain('"tag":"column_set"');
    expect(inputJson).toContain('"content":"Agent:"');
    expect(inputJson).toContain('"content":"Group policy:"');
    expect(inputJson).toContain('"content":"Reply trigger:"');
    expect(inputJson).toContain('"content":"Reply placement:"');
    expect(inputJson).not.toContain("**Agent**:");
    expect(inputJson).not.toContain("**Reply trigger**:");
    expect(inputJson).toContain('"name":"agentName"');
    expect(inputJson).toContain('"name":"groupPolicy"');
    expect(inputJson).toContain('"name":"replyTrigger"');
    expect(inputJson).toContain('"name":"replyPlacement"');
    expect(inputJson).toContain('"initial_option":"active"');
    expect(inputJson).toContain('"initial_option":"mention"');
    expect(inputJson).toContain('"initial_option":"thread"');
    expect(inputJson).toContain('"options":[{"text":{"tag":"plain_text","content":"main"}');
    expect(inputJson).not.toContain('"option":[');
    expect(inputJson).toContain('"action_type":"form_submit"');
    expect(inputJson).toContain('"name":"save_group_settings"');
    expect(inputJson).toContain('"text":{"tag":"plain_text","content":"Save"}');
    expect(inputJson).toContain('"text":{"tag":"plain_text","content":"Reset"}');
    expect(inputJson).not.toContain('"behaviors"');
    expect(inputJson).not.toContain('"tag":"action"');
  });

  it("leaves a group's configured agent to the conversation settings", async () => {
    const conversationSettings = makeConversationSettings({
      activation: { mode: "all" },
      routing: { agentName: "pm-assistant" },
    });
    channel = new FakeLarkChannel();
    adapter = new FeishuAdapter(
      {
        appId: "cli_test",
        appSecret: "secret",
        connectionId: FEISHU_CONNECTION_ID,
        conversationSettings: conversationSettings.control,
      },
      () => channel as unknown as LarkChannel,
    );
    captured = [];
    adapter.onInbound(async (msg) => {
      captured.push(msg);
    });
    await adapter.start();

    await channel.emit({ chatType: "group", mentionedBot: false, content: "please check" });

    // The inbox reads the agent from the conversation settings, so the
    // message carries no routing of its own.
    expect(captured).toHaveLength(1);
    expect(captured[0]).not.toHaveProperty("routing");
  });

  it("ignores normal group messages when group policy is disabled", async () => {
    const conversationSettings = makeConversationSettings({
      enabled: false,
      activation: { mode: "all" },
    });
    channel = new FakeLarkChannel();
    adapter = new FeishuAdapter(
      {
        appId: "cli_test",
        appSecret: "secret",
        connectionId: FEISHU_CONNECTION_ID,
        conversationSettings: conversationSettings.control,
        personMappingRepo: guardianPersonRepo("ou_alice"),
      },
      () => channel as unknown as LarkChannel,
    );
    captured = [];
    adapter.onInbound(async (msg) => {
      captured.push(msg);
    });
    await adapter.start();

    await channel.emit({ chatType: "group", mentionedBot: true, content: "@_user_1 hello" });

    expect(captured).toHaveLength(0);
  });

  it("delivers an addressed /stop when group policy is disabled", async () => {
    const conversationSettings = makeConversationSettings({
      enabled: false,
      activation: { mode: "all" },
    });
    channel = new FakeLarkChannel();
    adapter = new FeishuAdapter(
      {
        appId: "cli_test",
        appSecret: "secret",
        connectionId: FEISHU_CONNECTION_ID,
        conversationSettings: conversationSettings.control,
      },
      () => channel as unknown as LarkChannel,
    );
    captured = [];
    adapter.onInbound(async (msg) => {
      captured.push(msg);
    });
    await adapter.start();

    await channel.emit({
      chatType: "group",
      mentionedBot: true,
      content: "@_user_1 /stop",
      mentions: [{ key: "@_user_1", name: "Rome" }],
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ text: "/stop", addressing: "mention" });
  });

  it("renders current group settings as select field defaults", async () => {
    const conversationSettings = makeConversationSettings({
      activation: { mode: "all" },
      replies: { placement: "inline" },
    });
    channel = new FakeLarkChannel();
    adapter = new FeishuAdapter(
      {
        appId: "cli_test",
        appSecret: "secret",
        connectionId: FEISHU_CONNECTION_ID,
        conversationSettings: conversationSettings.control,
        personMappingRepo: guardianPersonRepo("ou_alice"),
      },
      () => channel as unknown as LarkChannel,
    );
    adapter.onInbound(async (msg) => {
      captured.push(msg);
    });
    await adapter.start();

    await channel.emit({
      chatType: "group",
      mentionedBot: true,
      content: "@_user_1 settings",
      mentions: [{ key: "@_user_1", name: "Rome" }],
    });

    const inputJson = JSON.stringify(channel.sent[0].input);
    expect(inputJson).toContain('"name":"groupPolicy"');
    expect(inputJson).toContain('"initial_option":"active"');
    expect(inputJson).toContain('"content":"Reply trigger:"');
    expect(inputJson).toContain('"name":"replyTrigger"');
    expect(inputJson).toContain('"initial_option":"all"');
    expect(inputJson).toContain('"content":"Reply placement:"');
    expect(inputJson).toContain('"name":"replyPlacement"');
    expect(inputJson).toContain('"initial_option":"inline"');
  });

  it("resolves @mention placeholders to display names", async () => {
    await channel.emit({
      content: "@_user_1 please review",
      mentions: [{ key: "@_user_1", name: "Rome" }],
    });
    expect(captured[0].text).toBe("Rome please review");
  });

  it("ignores the bot's own messages to avoid loops", async () => {
    await channel.emit({ senderId: "ou_bot" });
    expect(captured).toHaveLength(0);
  });

  it("ignores media-only messages with empty content (MVP scope)", async () => {
    await channel.emit({ content: "", rawContentType: "image" });
    expect(captured).toHaveLength(0);
  });

  it("carries the raw wire event on raw when present", async () => {
    await channel.emit({ raw: { wire: "event" } });
    expect(captured[0].raw).toEqual({ wire: "event" });
  });

  it("falls back to the SDK's normalized event when raw is absent", async () => {
    await channel.emit({});
    expect(captured[0].raw).toMatchObject({ messageId: "om_123" });
  });

  it("sends the agent's text as markdown for the SDK to render", async () => {
    const receipt = await adapter.send("oc_chat" as ConversationId, {
      text: "## Title\n**bold**\n- [x] done",
    });
    expect(receipt).toStrictEqual({ conversationId: "oc_chat", messageId: "om_sent" });
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]).toEqual({
      to: "oc_chat",
      input: { markdown: "## Title\n**bold**\n- [x] done" },
      opts: undefined,
    });
  });

  it("threads a reply via replyTo", async () => {
    await adapter.send("oc_chat" as ConversationId, { text: "ok", replyToMessageId: "om_42" });
    expect(channel.sent[0].opts).toEqual({ replyTo: "om_42", replyInThread: true });
  });

  it("honors autoThread=false for Feishu group replies", async () => {
    const conversationSettings = makeConversationSettings({
      replies: { placement: "inline" },
    });
    channel = new FakeLarkChannel();
    adapter = new FeishuAdapter(
      {
        appId: "cli_test",
        appSecret: "secret",
        connectionId: FEISHU_CONNECTION_ID,
        conversationSettings: conversationSettings.control,
      },
      () => channel as unknown as LarkChannel,
    );
    await adapter.start();

    await adapter.send("oc_chat" as ConversationId, { text: "ok", replyToMessageId: "om_42" });

    expect(channel.sent[0].opts).toEqual({ replyTo: "om_42", replyInThread: false });
  });

  it("adds and removes the exact Lark processing reaction", async () => {
    const reactionId = await adapter.addProcessingReaction("om_123");

    expect(reactionId).toBe("reaction-1");
    expect(channel.addedReactions).toEqual([
      { messageId: "om_123", emojiType: "Typing", reactionId: "reaction-1" },
    ]);

    await adapter.removeProcessingReaction("om_123", reactionId!);
    expect(channel.removedReactions).toEqual([{ messageId: "om_123", reactionId: "reaction-1" }]);
  });

  it("updates group configuration from a submitted card form", async () => {
    const conversationSettings = makeConversationSettings();
    channel = new FakeLarkChannel();
    adapter = new FeishuAdapter(
      {
        appId: "cli_test",
        appSecret: "secret",
        connectionId: FEISHU_CONNECTION_ID,
        conversationSettings: conversationSettings.control,
        personMappingRepo: guardianPersonRepo("ou_alice"),
        listAgents: () => ["main", "pm-assistant"],
      },
      () => channel as unknown as LarkChannel,
    );
    await adapter.start();

    await channel.emitCardAction({
      action: {
        tag: "button",
        value: {
          action: "configure_feishu_group",
          op: "save",
        },
      },
      raw: {
        action: {
          value: { action: "configure_feishu_group", op: "save" },
          form_value: {
            agentName: "pm-assistant",
            groupPolicy: "disabled",
            replyTrigger: "all",
            replyPlacement: "inline",
          },
        },
      },
    });

    expect(conversationSettings.update).toHaveBeenCalledWith({
      ref: { connectionId: FEISHU_CONNECTION_ID, conversationId: "oc_chat" },
      set: {
        enabled: false,
        activation: { mode: "all" },
        replies: { placement: "inline" },
        routing: { agentName: "pm-assistant" },
      },
      clear: [],
      actor: { kind: "guardian", id: "Alice" },
    });
    expect(channel.updatedCards).toHaveLength(0);
    expect(channel.sent[0]).toMatchObject({
      to: "oc_chat",
      input: {
        markdown: [
          "Feishu group settings updated.",
          "Agent: pm-assistant",
          "Group policy: Disabled",
          "Reply trigger: Every message",
          "Reply placement: Inline",
        ].join("\n"),
      },
      opts: { replyTo: "om_card" },
    });
  });

  it("rejects native settings submissions from an unlinked actor", async () => {
    const conversationSettings = makeConversationSettings();
    channel = new FakeLarkChannel();
    adapter = new FeishuAdapter(
      {
        appId: "cli_test",
        appSecret: "secret",
        connectionId: FEISHU_CONNECTION_ID,
        conversationSettings: conversationSettings.control,
        personMappingRepo: {
          findByChannelUser: async () => null,
        } as unknown as PersonMappingRepository,
      },
      () => channel as unknown as LarkChannel,
    );
    await adapter.start();

    await channel.emitCardAction({
      action: {
        tag: "button",
        value: { action: "configure_feishu_group", op: "save" },
      },
      raw: {
        action: {
          value: { action: "configure_feishu_group", op: "save" },
          form_value: {
            agentName: "pm-assistant",
            groupPolicy: "disabled",
            replyTrigger: "all",
            replyPlacement: "inline",
          },
        },
      },
    });

    expect(conversationSettings.update).not.toHaveBeenCalled();
    expect(channel.sent[0]).toMatchObject({
      input: { markdown: "Only the linked guardian can change this group." },
    });
  });

  it("clears default-valued policy fields and stores an explicit main-agent override", async () => {
    const conversationSettings = makeConversationSettings({
      enabled: false,
      activation: { mode: "all" },
      replies: { placement: "inline" },
      routing: { agentName: "pm-assistant" },
    });
    channel = new FakeLarkChannel();
    adapter = new FeishuAdapter(
      {
        appId: "cli_test",
        appSecret: "secret",
        connectionId: FEISHU_CONNECTION_ID,
        conversationSettings: conversationSettings.control,
        personMappingRepo: guardianPersonRepo("ou_alice"),
        listAgents: () => ["main", "pm-assistant"],
      },
      () => channel as unknown as LarkChannel,
    );
    await adapter.start();

    await channel.emitCardAction({
      action: {
        tag: "button",
        value: {
          action: "configure_feishu_group",
          op: "save",
        },
      },
      raw: {
        action: {
          value: { action: "configure_feishu_group", op: "save" },
          form_value: {
            agentName: "main",
            groupPolicy: "active",
            replyTrigger: "mention",
            replyPlacement: "thread",
          },
        },
      },
    });

    expect(conversationSettings.update).toHaveBeenCalledWith({
      ref: { connectionId: FEISHU_CONNECTION_ID, conversationId: "oc_chat" },
      set: { routing: { agentName: "main" } },
      clear: ["enabled", "activation.mode", "replies.placement"],
      actor: { kind: "guardian", id: "Alice" },
    });
    expect(channel.sent[0]).toMatchObject({
      to: "oc_chat",
      input: {
        markdown: [
          "Feishu group settings updated.",
          "Agent: main",
          "Group policy: Active",
          "Reply trigger: @ only",
          "Reply placement: Thread",
        ].join("\n"),
      },
      opts: { replyTo: "om_card" },
    });
  });

  it("resets all overrides through the shared reset operation", async () => {
    const conversationSettings = makeConversationSettings({
      enabled: false,
      routing: { agentName: "pm-assistant" },
    });
    channel = new FakeLarkChannel();
    adapter = new FeishuAdapter(
      {
        appId: "cli_test",
        appSecret: "secret",
        connectionId: FEISHU_CONNECTION_ID,
        conversationSettings: conversationSettings.control,
        personMappingRepo: guardianPersonRepo("ou_alice"),
      },
      () => channel as unknown as LarkChannel,
    );
    await adapter.start();

    await channel.emitCardAction({
      action: {
        tag: "button",
        value: { action: "configure_feishu_group", op: "reset" },
      },
      raw: {
        action: {
          value: { action: "configure_feishu_group", op: "reset" },
          form_value: {},
        },
      },
    });

    expect(conversationSettings.reset).toHaveBeenCalledWith({
      ref: { connectionId: FEISHU_CONNECTION_ID, conversationId: "oc_chat" },
      actor: { kind: "guardian", id: "Alice" },
    });
  });

  it("does not apply older immediate card actions", async () => {
    const conversationSettings = makeConversationSettings();
    channel = new FakeLarkChannel();
    adapter = new FeishuAdapter(
      {
        appId: "cli_test",
        appSecret: "secret",
        connectionId: FEISHU_CONNECTION_ID,
        conversationSettings: conversationSettings.control,
        personMappingRepo: guardianPersonRepo("ou_alice"),
        listAgents: () => ["main", "pm-assistant"],
      },
      () => channel as unknown as LarkChannel,
    );
    await adapter.start();

    await channel.emitCardAction({
      action: {
        tag: "select_static",
        option: "pm-assistant",
        value: { action: "configure_feishu_group", op: "agent_select" },
      },
    });

    expect(conversationSettings.update).not.toHaveBeenCalled();
    expect(channel.sent[0]).toMatchObject({
      to: "oc_chat",
      input: {
        markdown: "This settings card is outdated. Send `@Rome settings` again and use Save.",
      },
      opts: { replyTo: "om_card" },
    });
  });

  it("skips sending when there is no text body", async () => {
    const receipt = await adapter.send("oc_chat" as ConversationId, {});
    expect(receipt).toStrictEqual({ conversationId: "oc_chat" });
    expect(channel.sent).toHaveLength(0);
  });

  it("disconnects on stop", async () => {
    await adapter.stop();
    expect(channel.connected).toBe(false);
  });
});

describe("isFeishuAuthError", () => {
  it("recognizes permission_denied and Feishu auth codes as credential refusals", () => {
    expect(isFeishuAuthError(new LarkChannelError("permission_denied", "denied"))).toBe(true);
    expect(isFeishuAuthError({ code: 99991663 })).toBe(true);
    expect(isFeishuAuthError({ code: 10003 })).toBe(true);
    expect(isFeishuAuthError(new Error("invalid app_secret"))).toBe(true);
  });

  it("treats transport errors and unrelated codes as non-auth", () => {
    expect(isFeishuAuthError(new LarkChannelError("send_timeout", "slow"))).toBe(false);
    expect(isFeishuAuthError({ code: 500 })).toBe(false);
    expect(isFeishuAuthError(new Error("ECONNRESET"))).toBe(false);
  });
});

describe("FeishuAdapter fault surfacing", () => {
  it("forwards long-connection error events through onFault", async () => {
    const channel = new FakeLarkChannel();
    const faults: unknown[] = [];
    const adapter = new FeishuAdapter(
      { appId: "cli_test", appSecret: "secret", onFault: (err) => faults.push(err) },
      () => channel as unknown as LarkChannel,
    );
    await adapter.start();

    const err = new LarkChannelError("permission_denied", "revoked");
    channel.emitError(err);

    expect(faults).toEqual([err]);
  });
});

describe("resolveMentions", () => {
  it("replaces placeholders with names", () => {
    expect(resolveMentions("@_user_1 hi", [{ key: "@_user_1", name: "Bob" }])).toBe("Bob hi");
  });

  it("is a no-op without mentions", () => {
    expect(resolveMentions("plain text", [])).toBe("plain text");
  });
});

describe("FeishuAdapter history", () => {
  let channel: FakeLarkChannel;
  let adapter: FeishuAdapter;

  beforeEach(async () => {
    channel = new FakeLarkChannel();
    adapter = new FeishuAdapter(
      { appId: "cli_test", appSecret: "secret" },
      () => channel as unknown as LarkChannel,
    );
    adapter.onInbound(async () => {});
    await adapter.start();
  });

  it("reads one chat newest first from Feishu and answers it oldest first", async () => {
    await channel.emit({ chatId: "oc_other", chatType: "group", mentionedBot: true });
    channel.historyPages = [
      {
        items: [
          historyItem({ message_id: "om_2", create_time: "1700000060000" }),
          historyItem({ message_id: "om_1", create_time: "1700000000000" }),
        ],
      },
    ];

    const since = new Date(1_699_999_000_000);
    const messages = await adapter.fetchHistory("oc_sales", since, 100);

    expect(channel.historyCalls).toStrictEqual([
      {
        container_id_type: "chat",
        container_id: "oc_sales",
        start_time: "1699999000",
        sort_type: "ByCreateTimeDesc",
        page_size: 50,
      },
    ]);
    expect(messages.map((m) => m.messageId)).toStrictEqual(["om_1", "om_2"]);
    expect(messages[0]).toMatchObject({
      channel: "feishu",
      direction: "inbound",
      conversationId: "oc_sales",
      senderId: "ou_alice",
      senderDisplayName: "Alice",
      text: "the client wants a volume discount",
      thread: { kind: "group" },
      addressing: "ambient",
      timestamp: new Date(1_700_000_000_000),
    });
  });

  it("names a sender from the listed item, else as Feishu User when never heard from", async () => {
    channel.historyPages = [
      {
        items: [
          historyItem({
            message_id: "om_named",
            sender: {
              id: "ou_carol",
              id_type: "open_id",
              sender_type: "user",
              sender_name: "Carol",
            },
          }),
          historyItem({
            message_id: "om_unknown",
            sender: { id: "ou_dave", id_type: "open_id", sender_type: "user" },
          }),
        ],
      },
    ];

    const messages = await adapter.fetchHistory("oc_sales", new Date(0), 100);

    expect(messages.map((m) => m.senderDisplayName)).toStrictEqual(["Feishu User", "Carol"]);
  });

  it("follows page tokens and keeps only the newest `limit` messages", async () => {
    channel.historyPages = [
      {
        items: [historyItem({ message_id: "om_4" }), historyItem({ message_id: "om_3" })],
        has_more: true,
        page_token: "next",
      },
      {
        items: [historyItem({ message_id: "om_2" }), historyItem({ message_id: "om_1" })],
        has_more: false,
      },
    ];

    const messages = await adapter.fetchHistory("oc_sales", new Date(0), 3);

    expect(channel.historyCalls[1]).toMatchObject({ page_token: "next" });
    expect(messages.map((m) => m.messageId)).toStrictEqual(["om_2", "om_3", "om_4"]);
  });

  it("leaves out app messages, deleted messages and messages with no text", async () => {
    channel.historyPages = [
      {
        items: [
          historyItem({
            message_id: "om_app",
            sender: { id: "cli_test", id_type: "app_id", sender_type: "app" },
          }),
          historyItem({ message_id: "om_deleted", deleted: true }),
          historyItem({
            message_id: "om_image",
            msg_type: "image",
            body: { content: '{"image_key":"k"}' },
          }),
          historyItem({ message_id: "om_kept" }),
        ],
      },
    ];

    const messages = await adapter.fetchHistory("oc_sales", new Date(0), 100);

    expect(messages.map((m) => m.messageId)).toStrictEqual(["om_kept"]);
  });

  it("marks a message that mentions the bot and carries what it replied to", async () => {
    channel.historyPages = [
      {
        items: [
          historyItem({
            parent_id: "om_parent",
            body: { content: JSON.stringify({ text: "@_user_1 what is the list price?" }) },
            mentions: [{ key: "@_user_1", id: "ou_bot", id_type: "open_id", name: "Rome" }],
          }),
        ],
      },
    ];

    const [message] = await adapter.fetchHistory("oc_sales", new Date(0), 100);

    expect(message).toMatchObject({
      text: "Rome what is the list price?",
      addressing: "mention",
      replyTo: { messageId: "om_parent" },
    });
  });

  it("reads a private chat it has heard from as a direct conversation", async () => {
    await channel.emit({ chatId: "oc_dm", chatType: "p2p" });
    channel.historyPages = [{ items: [historyItem()] }];

    const [message] = await adapter.fetchHistory("oc_dm", new Date(0), 100);

    expect(message).toMatchObject({ thread: { kind: "dm" }, addressing: "direct" });
  });

  it("reads every group it has heard from when no chat is named", async () => {
    await channel.emit({ chatId: "oc_a", chatType: "group", mentionedBot: true });
    await channel.emit({ chatId: "oc_b", chatType: "group", mentionedBot: true });
    channel.historyPages = [
      { items: [historyItem({ message_id: "om_a", create_time: "1700000060000" })] },
      { items: [historyItem({ message_id: "om_b", create_time: "1700000000000" })] },
    ];

    const messages = await adapter.fetchHistory(null, new Date(0), 100);

    expect(channel.historyCalls.map((c) => c.container_id)).toStrictEqual(["oc_a", "oc_b"]);
    expect(messages.map((m) => m.messageId)).toStrictEqual(["om_b", "om_a"]);
  });

  it("pages each group at most four times in a read over every group", async () => {
    await channel.emit({ chatId: "oc_a", chatType: "group", mentionedBot: true });
    let calls = 0;
    channel.rawClient.im.v1.message.list = (async () => {
      calls++;
      return { code: 0, data: { items: [historyItem()], has_more: true, page_token: "more" } };
    }) as never;

    await adapter.fetchHistory(null, new Date(0), 1_000);

    expect(calls).toBe(4);
  });

  it("reads at most three groups at a time", async () => {
    for (const id of ["oc_a", "oc_b", "oc_c", "oc_d", "oc_e"]) {
      await channel.emit({ chatId: id, chatType: "group", mentionedBot: true });
    }
    let inFlight = 0;
    let peak = 0;
    channel.rawClient.im.v1.message.list = (async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return { code: 0, data: { items: [historyItem()] } };
    }) as never;

    const messages = await adapter.fetchHistory(null, new Date(0), 100);

    expect(messages).toHaveLength(5);
    expect(peak).toBe(3);
  });

  it("skips a group it cannot read when another group answers", async () => {
    await channel.emit({ chatId: "oc_a", chatType: "group", mentionedBot: true });
    await channel.emit({ chatId: "oc_b", chatType: "group", mentionedBot: true });
    channel.rawClient.im.v1.message.list = (async (payload: {
      params: { container_id: string };
    }) =>
      payload.params.container_id === "oc_a"
        ? { code: 230027, msg: "no permission", data: { items: [] } }
        : { code: 0, data: { items: [historyItem({ message_id: "om_b" })] } }) as never;

    const messages = await adapter.fetchHistory(null, new Date(0), 100);

    expect(messages.map((m) => m.messageId)).toStrictEqual(["om_b"]);
  });

  it("rejects the read of every group when Feishu refuses all of them", async () => {
    await channel.emit({ chatId: "oc_a", chatType: "group", mentionedBot: true });
    await channel.emit({ chatId: "oc_b", chatType: "group", mentionedBot: true });
    channel.rawClient.im.v1.message.list = async () =>
      ({ code: 99991663, msg: "invalid tenant access token", data: { items: [] } }) as never;

    await expect(adapter.fetchHistory(null, new Date(0), 100)).rejects.toThrow(/99991663/);
  });

  it("names Feishu's code when the refusal arrives as an HTTP error", async () => {
    channel.rawClient.im.v1.message.list = async () => {
      throw Object.assign(new Error("Request failed with status code 400"), {
        response: { status: 400, data: { code: 230027, msg: "no permission" } },
      });
    };

    await expect(adapter.fetchHistory("oc_sales", new Date(0), 100)).rejects.toThrow(
      "Feishu message list failed (230027): no permission",
    );
  });

  it("rejects when Feishu refuses the read of a named chat", async () => {
    channel.rawClient.im.v1.message.list = async () =>
      ({ code: 230027, msg: "no permission", data: { items: [] } }) as never;

    await expect(adapter.fetchHistory("oc_sales", new Date(0), 100)).rejects.toThrow(/230027/);
  });
});

describe("historyItemText", () => {
  it("joins a rich-text post's title and runs, mentions included", () => {
    const content = {
      zh_cn: {
        title: "Q3 pipeline",
        content: [
          [
            { tag: "at", user_id: "ou_bob", user_name: "Bob" },
            { tag: "text", text: " please check pricing" },
          ],
          [{ tag: "img", image_key: "k" }],
          [{ tag: "a", text: "deck", href: "https://example.com" }],
        ],
      },
    };

    expect(historyItemText({ msg_type: "post", body: { content: JSON.stringify(content) } })).toBe(
      "Q3 pipeline\n@Bob please check pricing\ndeck",
    );
  });

  it("names a post mention that carries only its key from the message's mentions", () => {
    const content = {
      content: [
        [
          { tag: "at", user_id: "@_user_1" },
          { tag: "text", text: " ping" },
        ],
      ],
    };

    expect(
      historyItemText({
        msg_type: "post",
        body: { content: JSON.stringify(content) },
        mentions: [{ key: "@_user_1", name: "Bob" }],
      }),
    ).toBe("Bob ping");
  });

  it("answers nothing for content that is not JSON", () => {
    expect(historyItemText({ msg_type: "text", body: { content: "not json" } })).toBe("");
  });
});
