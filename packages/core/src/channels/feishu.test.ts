import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
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
import { FeishuAdapter, isFeishuAuthError, resolveMentions } from "./feishu.js";
import type { NormalizedMessage } from "./types.js";

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
  const observe = vi.fn((descriptor: ConversationDescriptor) => {
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
  const get = vi.fn(async (ref: { conversationId: ConversationId }) =>
    makeSnapshot(ref.conversationId),
  );
  const update = vi.fn(async (input: Parameters<ConversationSettingsControl["update"]>[0]) => {
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
  const reset = vi.fn(async (input: Parameters<ConversationSettingsControl["reset"]>[0]) => {
    effective = structuredClone(defaults);
    return makeSnapshot(input.ref.conversationId);
  });
  const control = {
    observe,
    get,
    update,
    reset,
    list: vi.fn(),
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
  let captured: NormalizedMessage[];

  beforeEach(async () => {
    channel = new FakeLarkChannel();
    adapter = new FeishuAdapter(
      { appId: "cli_test", appSecret: "secret" },
      () => channel as unknown as LarkChannel,
    );
    captured = [];
    adapter.onMessage(async (msg) => {
      captured.push(msg);
    });
    await adapter.start();
  });

  it("connects on start", () => {
    expect(channel.connected).toBe(true);
  });

  it("normalizes an inbound private text message", async () => {
    await channel.emit({ content: "hi there" });
    expect(captured).toHaveLength(1);
    const msg = captured[0];
    expect(msg.channel).toBe("feishu");
    expect(msg.channelUserId).toBe("ou_alice");
    expect(msg.displayName).toBe("Alice");
    expect(msg.threadId).toBe("oc_chat");
    expect(msg.threadType).toBe("private");
    expect(msg.text).toBe("hi there");
    expect(msg.id).toBe("om_123");
  });

  it("maps group chat type to a group thread", async () => {
    await channel.emit({ chatType: "group", mentionedBot: true });
    expect(captured[0].threadType).toBe("group");
  });

  it("delivers an @-only group message as a greeting", async () => {
    await channel.emit({
      chatType: "group",
      content: "",
      rawContentType: "text",
      mentions: [],
      mentionedBot: true,
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].text).toBe("hello");
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
    adapter.onMessage(async (msg) => {
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

  it("routes group messages to the configured agent", async () => {
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
    adapter.onMessage(async (msg) => {
      captured.push(msg);
    });
    await adapter.start();

    await channel.emit({ chatType: "group", mentionedBot: false, content: "please check" });

    expect(captured).toHaveLength(1);
    expect(captured[0].routing).toEqual({ agentName: "pm-assistant" });
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
    adapter.onMessage(async (msg) => {
      captured.push(msg);
    });
    await adapter.start();

    await channel.emit({ chatType: "group", mentionedBot: true, content: "@_user_1 hello" });

    expect(captured).toHaveLength(0);
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
    adapter.onMessage(async (msg) => {
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

  it("carries the raw wire event on rawEvent when present", async () => {
    await channel.emit({ raw: { wire: "event" } });
    expect(captured[0].rawEvent).toEqual({ wire: "event" });
  });

  it("falls back to the normalized message when raw is absent", async () => {
    await channel.emit({});
    expect(captured[0].rawEvent).toMatchObject({ messageId: "om_123" });
  });

  it("sends the agent's text as markdown for the SDK to render", async () => {
    await adapter.sendMessage("ou_alice", "oc_chat", { text: "## Title\n**bold**\n- [x] done" });
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]).toEqual({
      to: "oc_chat",
      input: { markdown: "## Title\n**bold**\n- [x] done" },
      opts: undefined,
    });
  });

  it("threads a reply via replyTo", async () => {
    await adapter.sendMessage("ou_alice", "oc_chat", { text: "ok", replyToMessageId: "om_42" });
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

    await adapter.sendMessage("ou_alice", "oc_chat", { text: "ok", replyToMessageId: "om_42" });

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
    await adapter.sendMessage("ou_alice", "oc_chat", {});
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
