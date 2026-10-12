import {
  createLarkChannel,
  type CardActionEvent,
  Domain,
  type LarkChannel,
  LarkChannelError,
  LoggerLevel,
  type NormalizedMessage as LarkMessage,
} from "@larksuiteoapi/node-sdk";
import { isStopCommand } from "@rome-os/app-runtime";
import { preserveMentionOnlyText } from "./mention-only.js";
import type { OutgoingMessage } from "./types.js";
import { createLogger } from "../logger.js";
import type { PersonMappingRepository } from "../db/repositories/person-mapping.js";
import type {
  ChannelMessage,
  ConversationDescriptor,
  ConversationId,
  ConversationSettingsControl,
  MessageAddressing,
  MessageReceipt,
} from "@rome-os/app-runtime";

const log = createLogger("feishu");
const PROCESSING_REACTION_EMOJI = "Typing";
/** Feishu content types whose bot mention can be the whole message. */
const TEXT_BEARING_CONTENT_TYPES: ReadonlySet<string> = new Set(["text", "post"]);
/** Feishu's largest page for `im.v1.message.list`. */
const HISTORY_PAGE_SIZE = 50;
/** Pages one chat's history read may take, which bounds a read at 1,000 messages. */
const MAX_HISTORY_PAGES = 20;
// A read over every group pages each chat less deeply, since the merged answer
// keeps only the newest `limit` messages across all of them.
const MAX_HISTORY_PAGES_PER_GROUP = 4;
const HISTORY_CHAT_CONCURRENCY = 3;

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  /** "feishu" = open.feishu.cn (China), "lark" = open.larksuite.com
   *  (International). Defaults to "feishu". */
  domain?: "feishu" | "lark";
  connectionId?: string;
  conversationSettings?: ConversationSettingsControl & {
    observe?(descriptor: ConversationDescriptor): void;
  };
  personMappingRepo?: PersonMappingRepository;
  listAgents?: () => string[];
  /**
   * Optional fault seam the Talker wires in. Fires on a terminal
   * `error` event from the long connection so the Talker maps it (auth →
   * CredentialRejected via {@link isFeishuAuthError}, else Disconnected). A
   * bad-credential `connect()` at start rejects out of {@link FeishuAdapter.start}
   * instead, which the Talker routes the same way. ChannelManager passes no
   * callback, so its behavior (error logged, swallowed) is unchanged.
   */
  onFault?: (err: unknown) => void;
}

/**
 * True iff `err` is a Feishu "credential refused" — the app's tenant-access-token
 * could not be minted / was rejected (bad appId/appSecret or a revoked app). We
 * recognize it via the SDK's `permission_denied` {@link LarkChannelError} code
 * and the Feishu auth error codes (10003 app_ticket, 99991663/99991664/99991679
 * tenant-access-token). This is the ONLY Feishu signal that maps to grant
 * state; every other websocket/transport failure is a `Disconnected`.
 */
export function isFeishuAuthError(err: unknown): boolean {
  if (err instanceof LarkChannelError && err.code === "permission_denied") return true;
  const code = extractFeishuErrorCode(err);
  if (code !== null && FEISHU_AUTH_ERROR_CODES.has(code)) return true;
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /\b(invalid app_secret|app not exist|access token|permission denied)\b/i.test(message);
}

const FEISHU_AUTH_ERROR_CODES = new Set<number>([10003, 99991663, 99991664, 99991679]);

function extractFeishuErrorCode(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const record = err as { code?: unknown; response?: { data?: { code?: unknown } } };
  const direct = typeof record.code === "number" ? record.code : null;
  if (direct !== null) return direct;
  const nested = record.response?.data?.code;
  return typeof nested === "number" ? nested : null;
}

interface FeishuChannelConfig {
  chatName?: string;
  mode?: "allow" | "ignore";
  requireMention?: boolean;
  autoThread?: boolean;
  agentName?: string;
  updatedAt?: string;
  updatedBy?: string;
}

/**
 * The transport seam: tests inject a fake LarkChannel instead of module-mocking
 * the SDK. Mirrors the `createBot` injection in {@link TelegramAdapter}.
 */
export type CreateLarkChannel = (config: FeishuConfig) => LarkChannel;

/**
 * Feishu / Lark channel adapter.
 *
 * Built on the official SDK's high-level {@link LarkChannel} — the same engine
 * the official OpenClaw Feishu plugin uses. It runs the long connection
 * (WebSocket), so no public URL/webhook is needed, and owns the parts we'd
 * otherwise hand-roll:
 *
 * - inbound `on("message")` events arrive already normalized (sender name,
 *   resolved chat type, structured mentions). The adapter maps each onto the
 *   channel's own record, a `ChannelMessage` whose `raw` is the SDK's wire
 *   event, so the Connection integration delivers it as it is;
 * - outbound `send(..., { markdown })` runs the SDK's builtin converter, which
 *   renders the text as a Feishu rich-text post so bold/lists/code/headings
 *   display correctly. Agent output is Markdown by design, so every reply takes
 *   this path — no need to sniff whether a given message "looks like" Markdown.
 *
 * Media attachments remain out of scope (text/post only).
 */
export class FeishuAdapter {
  private channel: LarkChannel;
  private handler?: (msg: ChannelMessage) => Promise<void>;
  private readonly connectionId?: string;
  private readonly conversationSettings?: ConversationSettingsControl & {
    observe?(descriptor: ConversationDescriptor): void;
  };
  private readonly personMappingRepo?: PersonMappingRepository;
  private readonly listAgents?: () => string[];
  private readonly onFault?: (err: unknown) => void;
  private readonly observedConversations = new Map<
    string,
    { id: string; displayName: string; kind: "group" | "channel" }
  >();
  /** Private chats seen inbound, so a history read can tell a DM from a group. */
  private readonly privateChats = new Set<string>();
  /**
   * Names of senders seen inbound, by open_id. `message.list` may leave
   * `sender_name` out, and a history read falls back to these.
   */
  private readonly senderNames = new Map<string, string>();
  /** Unsubscribe callbacks from channel.on(), cleared on stop() so handlers
   *  don't accumulate if the adapter is ever started again. */
  private unsubscribes: Array<() => void> = [];

  constructor(
    config: FeishuConfig,
    createChannel: CreateLarkChannel = (c) =>
      createLarkChannel({
        appId: c.appId,
        appSecret: c.appSecret,
        domain: c.domain === "lark" ? Domain.Lark : Domain.Feishu,
        transport: "websocket",
        outbound: { markdownConverter: "builtin" },
        // Populate `raw` on normalized events so the inbound message's `raw`
        // carries the real wire-level payload (e.g. for media not surfaced in
        // the normal shape).
        includeRawEvent: true,
        loggerLevel: LoggerLevel.warn,
      }),
  ) {
    this.channel = createChannel(config);
    this.connectionId = config.connectionId;
    this.conversationSettings = config.conversationSettings;
    this.personMappingRepo = config.personMappingRepo;
    this.listAgents = config.listAgents;
    this.onFault = config.onFault;
  }

  async start(): Promise<void> {
    this.unsubscribes.push(
      this.channel.on("message", async (msg) => {
        await this.handleMessage(msg);
      }),
      this.channel.on("cardAction", async (evt) => {
        await this.handleCardAction(evt);
      }),
      this.channel.on("error", (err) => {
        log.error("lark channel error", {
          error: err instanceof Error ? err.message : String(err),
        });
        // Surface terminal long-connection errors to the Talker; it maps
        // auth failures to CredentialRejected and everything else to Disconnected.
        this.onFault?.(err);
      }),
    );

    // connect() resolves once the long connection is established, so awaiting it
    // surfaces bad credentials at boot rather than silently dropping events.
    await this.channel.connect();
    log.info("feishu adapter started");
  }

  async stop(): Promise<void> {
    this.unsubscribes.splice(0).forEach((fn) => fn());
    await this.channel.disconnect();
    log.info("feishu adapter stopped");
  }

  async send(conversationId: ConversationId, message: OutgoingMessage): Promise<MessageReceipt> {
    if (!message.text) return { conversationId };
    const threadId: string = conversationId;

    // Agent output is Markdown; let the SDK render it as a rich-text post.
    const opts = message.replyToMessageId
      ? {
          replyTo: message.replyToMessageId,
          replyInThread: (await this.getChannelConfig(threadId)).autoThread ?? true,
        }
      : undefined;

    try {
      const sent = (await this.channel.send(
        threadId,
        { markdown: message.text },
        opts,
      )) as unknown as {
        messageId?: string;
        message_id?: string;
      };
      log.info("message sent", { threadId });
      const messageId = sent?.messageId ?? sent?.message_id;
      return { conversationId, ...(messageId ? { messageId } : {}) };
    } catch (err) {
      log.error("failed to send message", {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  onInbound(handler: (msg: ChannelMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async addProcessingReaction(messageId: string): Promise<string | null> {
    return this.channel.addReaction(messageId, PROCESSING_REACTION_EMOJI);
  }

  async removeProcessingReaction(messageId: string, reactionId: string): Promise<void> {
    await this.channel.removeReaction(messageId, reactionId);
  }

  /**
   * What people said in one chat, or in every group chat seen since the adapter
   * started when `chatId` is null: the newest `limit` messages created at or
   * after `since`, oldest first. Messages from apps, this bot included, are left
   * out, as Discord's read leaves out bots, and so are messages with no text.
   * Across every chat, one chat that fails is logged and skipped; when all of
   * them fail the read rejects with the first error.
   *
   * Reading a group's messages that do not mention the bot needs the app's
   * `im:message.group_msg:readonly` scope, which the agent-ready registration
   * already requests.
   */
  async fetchHistory(chatId: string | null, since: Date, limit: number): Promise<ChannelMessage[]> {
    if (chatId !== null) return this.fetchChatHistory(chatId, since, limit, MAX_HISTORY_PAGES);
    const chatIds = [...this.observedConversations.keys()];
    // A few chats at a time, so a bot in many groups stays under Feishu's
    // per-app rate limit on `message.list`.
    const perChat = new Array<PromiseSettledResult<ChannelMessage[]>>(chatIds.length);
    let next = 0;
    const readers = Array.from(
      { length: Math.min(HISTORY_CHAT_CONCURRENCY, chatIds.length) },
      async () => {
        for (let i = next++; i < chatIds.length; i = next++) {
          [perChat[i]] = await Promise.allSettled([
            this.fetchChatHistory(chatIds[i], since, limit, MAX_HISTORY_PAGES_PER_GROUP),
          ]);
        }
      },
    );
    await Promise.all(readers);
    const failures = perChat.flatMap((result, i) =>
      result.status === "rejected" ? [{ chatId: chatIds[i], reason: result.reason }] : [],
    );
    // Every chat failing means Feishu refused the read itself (a missing scope,
    // revoked credentials), which an empty answer would pass off as silence.
    if (failures.length > 0 && failures.length === perChat.length) throw failures[0]?.reason;
    for (const { chatId: id, reason } of failures) {
      log.warn("failed to read Feishu chat history", {
        chatId: id,
        error: reason instanceof Error ? reason.message : String(reason),
      });
    }
    return perChat
      .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
      .slice(-limit);
  }

  private async fetchChatHistory(
    chatId: string,
    since: Date,
    limit: number,
    maxPages: number,
  ): Promise<ChannelMessage[]> {
    const newestFirst: ChannelMessage[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < maxPages && newestFirst.length < limit; page++) {
      let res: Awaited<ReturnType<typeof this.channel.rawClient.im.v1.message.list>>;
      try {
        res = await this.channel.rawClient.im.v1.message.list({
          params: {
            container_id_type: "chat",
            container_id: chatId,
            start_time: String(Math.floor(since.getTime() / 1000)),
            sort_type: "ByCreateTimeDesc",
            page_size: HISTORY_PAGE_SIZE,
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        });
      } catch (err) {
        // Feishu answers most refusals with HTTP 400, which the SDK throws with
        // the Feishu code in the response body.
        const body = (err as { response?: { data?: { code?: unknown; msg?: unknown } } }).response
          ?.data;
        if (typeof body?.code !== "number") throw err;
        res = { code: body.code, msg: typeof body.msg === "string" ? body.msg : undefined };
      }
      if (res.code !== undefined && res.code !== 0) {
        throw new Error(`Feishu message list failed (${res.code}): ${res.msg ?? "no message"}`);
      }
      for (const item of res.data?.items ?? []) {
        const message = this.historyItemToChannelMessage(item, chatId);
        if (message) newestFirst.push(message);
      }
      if (!res.data?.has_more || !res.data.page_token) break;
      pageToken = res.data.page_token;
    }
    return newestFirst.slice(0, limit).reverse();
  }

  private historyItemToChannelMessage(
    item: FeishuHistoryItem,
    chatId: string,
  ): ChannelMessage | null {
    if (!item.message_id || item.deleted) return null;
    if (item.sender?.sender_type !== "user") return null;
    const text = historyItemText(item);
    if (!text) return null;
    const kind = this.privateChats.has(chatId) ? "dm" : "group";
    const botOpenId = this.channel.botIdentity?.openId;
    const mentionedBot =
      botOpenId !== undefined && (item.mentions ?? []).some((m) => m.id === botOpenId);
    const createTime = Number(item.create_time);
    return {
      channel: "feishu",
      direction: "inbound",
      messageId: item.message_id,
      conversationId: chatId as ConversationId,
      senderId: item.sender.id,
      senderDisplayName:
        item.sender.sender_name ?? this.senderNames.get(item.sender.id) ?? "Feishu User",
      text,
      attachments: [],
      timestamp: new Date(Number.isFinite(createTime) ? createTime : 0),
      ...(item.parent_id ? { replyTo: { messageId: item.parent_id } } : {}),
      thread: { kind },
      addressing: kind === "dm" ? "direct" : mentionedBot ? "mention" : "ambient",
      raw: item,
    };
  }

  private async handleMessage(m: LarkMessage): Promise<void> {
    if (!this.handler) return;

    // Skip the bot's own messages to avoid loops (the SDK knows its identity
    // once connected).
    if (m.senderId && m.senderId === this.channel.botIdentity?.openId) return;

    // MVP: text-bearing messages only. Media-only messages arrive with empty
    // content and are dropped until attachment support lands. The SDK strips
    // the bot mention, so a text or rich-text post that was only the mention
    // is restored as the visible mention instead of being dropped.
    const commandText = stripMentionPlaceholders(m.content ?? "", m.mentions);
    const resolvedText = resolveMentions(m.content ?? "", m.mentions);
    const text =
      m.mentionedBot && isStopCommand(commandText)
        ? "/stop"
        : preserveMentionOnlyText(
            resolvedText,
            m.mentionedBot && TEXT_BEARING_CONTENT_TYPES.has(m.rawContentType),
            this.channel.botIdentity?.name,
          );
    if (!text) return;
    const threadType = m.chatType === "p2p" ? "private" : "group";
    if (threadType === "private") this.privateChats.add(m.chatId);
    if (m.senderName) this.senderNames.set(m.senderId, m.senderName);
    const addressing: MessageAddressing =
      threadType === "private" ? "direct" : m.mentionedBot ? "mention" : "ambient";
    const directedStop = addressing !== "ambient" && isStopCommand(text);
    if (threadType === "group") {
      this.observedConversations.set(m.chatId, {
        id: m.chatId,
        displayName: m.chatId,
        kind: "group",
      });
    }

    if (threadType === "group") {
      const configRequest = isSettingsRequest(text);
      if (configRequest && m.mentionedBot) {
        await this.sendGroupConfigCard(m.chatId, m.messageId, m.senderId);
        return;
      }

      const cfg = await this.getChannelConfig(m.chatId);
      if (cfg.mode === "ignore" && !directedStop) {
        log.debug("ignoring Feishu group message because group policy is disabled", {
          from: m.senderId,
          threadId: m.chatId,
        });
        return;
      }
      if ((cfg.requireMention ?? true) && !m.mentionedBot) {
        log.debug("ignoring Feishu group message not mentioning bot", {
          from: m.senderId,
          threadId: m.chatId,
        });
        return;
      }
    }

    // The group's agent is not stamped on the message. The inbox reads it
    // from the conversation settings.
    const msg: ChannelMessage = {
      channel: "feishu",
      direction: "inbound",
      messageId: m.messageId,
      conversationId: m.chatId as ConversationId,
      senderId: m.senderId,
      senderDisplayName: m.senderName ?? "Feishu User",
      text,
      attachments: [],
      timestamp: new Date(m.createTime),
      ...(m.replyToMessageId ? { replyTo: { messageId: m.replyToMessageId } } : {}),
      thread: { kind: threadType === "private" ? "dm" : "group" },
      addressing,
      raw: m.raw ?? m,
    };

    log.info("message received", {
      from: msg.senderId,
      conversationId: msg.conversationId,
      threadKind: msg.thread?.kind,
    });

    try {
      await this.handler(msg);
    } catch (err) {
      log.error("message handler error", {
        messageId: msg.messageId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleCardAction(evt: CardActionEvent): Promise<void> {
    const value = evt.action.value;
    if (isFeishuGroupConfigAction(value)) {
      await this.handleGroupConfigAction(evt);
    }
  }

  listObservedConversations() {
    return [...this.observedConversations.values()];
  }

  private async sendGroupConfigCard(
    chatId: string,
    replyToMessageId: string,
    channelUserId: string,
    error?: string,
  ): Promise<void> {
    if (!(await this.isGuardian(channelUserId))) {
      await this.channel.send(
        chatId,
        { markdown: "Only the linked guardian can configure this Feishu group." },
        { replyTo: replyToMessageId },
      );
      return;
    }

    const cfg = await this.getChannelConfig(chatId);
    await this.channel.send(
      chatId,
      { card: buildGroupConfigCard(chatId, cfg, this.getAgentOptions(cfg.agentName), error) },
      {
        replyTo: replyToMessageId,
      },
    );
  }

  private async handleGroupConfigAction(evt: CardActionEvent): Promise<void> {
    const value = evt.action.value;
    if (!isFeishuGroupConfigAction(value)) return;
    if (!this.conversationSettings || !this.connectionId) {
      await this.sendGroupConfigStatus(
        evt.chatId,
        evt.messageId,
        "Conversation settings are unavailable.",
      );
      return;
    }
    if (!(await this.isGuardian(evt.operator.openId))) {
      await this.sendGroupConfigStatus(
        evt.chatId,
        evt.messageId,
        "Only the linked guardian can change this group.",
      );
      return;
    }

    const op = typeof value.op === "string" ? value.op : "save";
    const patch = this.buildGroupConfigPatch(op, value, evt.raw);

    if (patch === undefined) {
      await this.sendGroupConfigStatus(
        evt.chatId,
        evt.messageId,
        "This settings card is outdated. Send `@Rome settings` again and use Save.",
      );
      return;
    }

    if (patch?.agentName) {
      const available = this.listAgents?.();
      if (available && !available.includes(patch.agentName)) {
        await this.sendGroupConfigStatus(
          evt.chatId,
          evt.messageId,
          `Agent "${patch.agentName}" is not loaded.`,
        );
        return;
      }
    }

    const next = await this.updateChannelConfig(evt.chatId, patch, evt.operator.name);
    log.info("updated Feishu group configuration", {
      chatId: evt.chatId,
      op,
      mode: next.mode ?? "allow",
      requireMention: next.requireMention ?? true,
      autoThread: next.autoThread ?? true,
      agentName: next.agentName ?? "main",
      operator: evt.operator.openId,
    });
    await this.sendGroupConfigStatus(
      evt.chatId,
      evt.messageId,
      formatGroupConfigConfirmation(next),
    );
  }

  private async sendGroupConfigStatus(
    chatId: string,
    replyToMessageId: string,
    text: string,
  ): Promise<void> {
    try {
      await this.channel.send(chatId, { markdown: text }, { replyTo: replyToMessageId });
    } catch (err) {
      log.error("failed to send Feishu group config status", {
        chatId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async isGuardian(channelUserId: string): Promise<boolean> {
    if (!this.personMappingRepo) return false;
    const person = await this.personMappingRepo.findByChannelUser("feishu", channelUserId);
    return person?.bondLevel === "guardian";
  }

  private buildAgentPatch(agentName: unknown): Partial<FeishuChannelConfig> {
    const requestedAgent = typeof agentName === "string" ? agentName.trim() : "";
    return {
      agentName: requestedAgent || undefined,
    };
  }

  private buildGroupConfigPatch(
    op: string,
    value: Record<string, unknown>,
    raw: unknown,
  ): Partial<FeishuChannelConfig> | null | undefined {
    if (op === "reset") return null;
    if (op !== "save") return undefined;

    const patch: Partial<FeishuChannelConfig> = {
      ...this.buildAgentPatch(extractCardActionField(value, raw, "agentName")),
    };

    const groupPolicy = extractCardActionField(value, raw, "groupPolicy");
    if (groupPolicy === "active") patch.mode = undefined;
    if (groupPolicy === "disabled") patch.mode = "ignore";

    const replyTrigger = extractCardActionField(value, raw, "replyTrigger");
    if (replyTrigger === "mention") patch.requireMention = undefined;
    if (replyTrigger === "all") patch.requireMention = false;

    const replyPlacement = extractCardActionField(value, raw, "replyPlacement");
    if (replyPlacement === "thread") patch.autoThread = undefined;
    if (replyPlacement === "inline") patch.autoThread = false;

    return patch;
  }

  private getAgentOptions(currentAgent?: string): string[] {
    return Array.from(
      new Set(["main", currentAgent, ...(this.listAgents?.() ?? [])].filter(Boolean)),
    )
      .map(String)
      .slice(0, 20);
  }

  private async getChannelConfig(chatId: string): Promise<FeishuChannelConfig> {
    if (!this.conversationSettings || !this.connectionId) return {};
    const observed = this.observedConversations.get(chatId);
    const descriptor: ConversationDescriptor = {
      ref: { connectionId: this.connectionId, conversationId: chatId as ConversationId },
      service: "feishu",
      kind: observed?.kind ?? "group",
      displayName: observed?.displayName ?? chatId,
    };
    this.conversationSettings.observe?.(descriptor);
    const snapshot = await this.conversationSettings.get(descriptor.ref);
    return {
      chatName: descriptor.displayName,
      mode: snapshot.effective.enabled ? "allow" : "ignore",
      requireMention: snapshot.effective.activation.mode === "mention",
      autoThread: snapshot.effective.replies.placement === "thread",
      agentName: snapshot.effective.routing.agentName ?? undefined,
      updatedAt: snapshot.updatedAt,
      updatedBy: snapshot.updatedBy?.displayName ?? snapshot.updatedBy?.id,
    };
  }

  private async updateChannelConfig(
    chatId: string,
    patch: Partial<FeishuChannelConfig> | null,
    updatedBy?: string,
  ): Promise<FeishuChannelConfig> {
    if (!this.conversationSettings || !this.connectionId) return {};
    const current = await this.getChannelConfig(chatId);
    const ref = { connectionId: this.connectionId, conversationId: chatId as ConversationId };
    if (patch === null) {
      const saved = await this.conversationSettings.reset({
        ref,
        actor: { kind: "guardian", id: updatedBy ?? "feishu-card" },
      });
      return {
        mode: saved.effective.enabled ? "allow" : "ignore",
        requireMention: saved.effective.activation.mode === "mention",
        autoThread: saved.effective.replies.placement === "thread",
        agentName: saved.effective.routing.agentName ?? undefined,
      };
    }
    const set: import("@rome-os/app-runtime").PartialConversationSettings = {};
    const clear: import("@rome-os/app-runtime").ConversationSettingField[] = [];
    const owns = (key: keyof FeishuChannelConfig) => Object.hasOwn(patch, key);
    if (owns("mode")) {
      if (patch.mode === "ignore") set.enabled = false;
      else clear.push("enabled");
    }
    if (owns("requireMention")) {
      if (patch.requireMention === false) (set.activation ??= {}).mode = "all";
      else clear.push("activation.mode");
    }
    if (owns("autoThread")) {
      if (patch.autoThread === false) (set.replies ??= {}).placement = "inline";
      else clear.push("replies.placement");
    }
    if (owns("agentName")) {
      if (patch.agentName) (set.routing ??= {}).agentName = patch.agentName;
      else clear.push("routing.agentName");
    }
    await this.conversationSettings.update({
      ref,
      set,
      clear,
      actor: { kind: "guardian", id: updatedBy ?? "feishu-card" },
    });
    return this.getChannelConfig(chatId).then((saved) => ({ ...current, ...saved }));
  }
}

/** One item of Feishu's `im.v1.message.list` answer, as far as history reads it. */
type FeishuHistoryItem = NonNullable<
  NonNullable<
    Awaited<ReturnType<LarkChannel["rawClient"]["im"]["v1"]["message"]["list"]>>["data"]
  >["items"]
>[number];

/**
 * The words of a listed message: a text message's text with its mention
 * placeholders resolved, or a rich-text post's title and runs. Other message
 * types (images, files, cards) have no text and answer "".
 */
export function historyItemText(item: {
  msg_type?: string;
  body?: { content: string };
  mentions?: Array<{ key?: string; name?: string }>;
}): string {
  let content: unknown;
  try {
    content = JSON.parse(item.body?.content ?? "");
  } catch {
    return "";
  }
  if (typeof content !== "object" || content === null) return "";
  if (item.msg_type === "text") {
    const text = (content as { text?: unknown }).text;
    return typeof text === "string" ? resolveMentions(text, item.mentions ?? []) : "";
  }
  if (item.msg_type === "post") return resolveMentions(postText(content), item.mentions ?? []);
  return "";
}

/** A post's body arrives either bare or keyed by locale (`zh_cn`, `en_us`). */
function postText(content: object): string {
  const bare = content as { title?: unknown; content?: unknown };
  const post = Array.isArray(bare.content)
    ? bare
    : ((Object.values(content).find(
        (value) =>
          typeof value === "object" &&
          value !== null &&
          Array.isArray((value as { content?: unknown }).content),
      ) as typeof bare | undefined) ?? bare);
  const lines: string[] = [];
  if (typeof post.title === "string" && post.title.trim()) lines.push(post.title.trim());
  for (const paragraph of Array.isArray(post.content) ? post.content : []) {
    if (!Array.isArray(paragraph)) continue;
    const line = paragraph
      .map((run: { tag?: string; text?: string; user_id?: string; user_name?: string }) => {
        // Without a name, keep the `@_user_N` key so the message's mentions can name it.
        if (run.tag === "at") return run.user_name ? `@${run.user_name}` : (run.user_id ?? "");
        return typeof run.text === "string" ? run.text : "";
      })
      .join("");
    if (line.trim()) lines.push(line);
  }
  return lines.join("\n");
}

/**
 * Replace `@_user_N` / `@_all` mention placeholders the SDK leaves in `content`
 * with the resolved display name from its structured `mentions`, so the agent
 * sees clean prose. A no-op when there are no mentions.
 */
export function resolveMentions(
  content: string,
  mentions: Array<{ key?: string; name?: string }>,
): string {
  let text = content;
  for (const mention of mentions) {
    if (mention.key && mention.name) text = text.split(mention.key).join(mention.name);
  }
  return text.trim();
}

function stripMentionPlaceholders(
  content: string,
  mentions: Array<{ key?: string; name?: string }>,
): string {
  let text = content;
  for (const mention of mentions) {
    if (mention.key) text = text.split(mention.key).join("");
  }
  return text.trim();
}

function buildGroupConfigCard(
  chatId: string,
  cfg: FeishuChannelConfig,
  agentOptions: string[],
  error?: string,
): object {
  const agent = cfg.agentName ?? "main";
  const groupPolicy = cfg.mode === "ignore" ? "disabled" : "active";
  const requireMention = cfg.requireMention ?? true;
  const autoThread = cfg.autoThread ?? true;
  const elements: object[] = [];

  if (error) {
    elements.push({
      tag: "div",
      text: { tag: "plain_text", content: error },
    });
  }

  elements.push({
    tag: "form",
    name: "rome_feishu_group_config",
    elements: [
      fieldRow("Agent:", {
        tag: "select_static",
        name: "agentName",
        placeholder: { tag: "plain_text", content: "Route to agent" },
        initial_option: agent,
        options: agentOptions.map((name) => ({
          text: { tag: "plain_text", content: name },
          value: name,
        })),
      }),
      fieldRow("Group policy:", {
        tag: "select_static",
        name: "groupPolicy",
        placeholder: { tag: "plain_text", content: "Group policy" },
        initial_option: groupPolicy,
        options: [
          {
            text: { tag: "plain_text", content: "Active" },
            value: "active",
          },
          {
            text: { tag: "plain_text", content: "Disabled" },
            value: "disabled",
          },
        ],
      }),
      fieldRow("Reply trigger:", {
        tag: "select_static",
        name: "replyTrigger",
        placeholder: { tag: "plain_text", content: "Reply trigger" },
        initial_option: requireMention ? "mention" : "all",
        options: [
          {
            text: { tag: "plain_text", content: "@ only" },
            value: "mention",
          },
          {
            text: { tag: "plain_text", content: "Every message" },
            value: "all",
          },
        ],
      }),
      fieldRow("Reply placement:", {
        tag: "select_static",
        name: "replyPlacement",
        placeholder: { tag: "plain_text", content: "Reply placement" },
        initial_option: autoThread ? "thread" : "inline",
        options: [
          {
            text: { tag: "plain_text", content: "Thread" },
            value: "thread",
          },
          {
            text: { tag: "plain_text", content: "Inline" },
            value: "inline",
          },
        ],
      }),
      {
        tag: "button",
        action_type: "form_submit",
        name: "save_group_settings",
        type: "primary",
        text: { tag: "plain_text", content: "Save" },
        value: { action: "configure_feishu_group", op: "save", chatId },
      },
      {
        tag: "button",
        action_type: "form_submit",
        name: "reset_group_settings",
        text: { tag: "plain_text", content: "Reset" },
        value: { action: "configure_feishu_group", op: "reset", chatId },
      },
    ],
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      template: error ? "red" : "blue",
      title: { tag: "plain_text", content: "Rome group settings" },
    },
    elements,
  };
}

function fieldRow(label: string, control: object): object {
  return {
    tag: "column_set",
    columns: [
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        vertical_align: "center",
        elements: [{ tag: "markdown", content: label }],
      },
      {
        tag: "column",
        width: "weighted",
        weight: 2,
        vertical_align: "center",
        elements: [control],
      },
    ],
  };
}

function formatGroupConfigConfirmation(cfg: FeishuChannelConfig): string {
  return [
    "Feishu group settings updated.",
    `Agent: ${cfg.agentName ?? "main"}`,
    `Group policy: ${cfg.mode === "ignore" ? "Disabled" : "Active"}`,
    `Reply trigger: ${(cfg.requireMention ?? true) ? "@ only" : "Every message"}`,
    `Reply placement: ${(cfg.autoThread ?? true) ? "Thread" : "Inline"}`,
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFeishuGroupConfigAction(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return value.action === "configure_feishu_group";
}

function isSettingsRequest(text: string): boolean {
  return /(^|\s)(settings?|config|configure|设置|配置)(\s|$)/i.test(text.trim());
}

function extractStringField(value: unknown, field: string): string | null {
  if (!isRecord(value)) return null;
  const direct = value[field];
  if (typeof direct === "string" || typeof direct === "number") return String(direct);

  for (const key of ["form_value", "formValue", "formValues", "form"]) {
    const form = value[key];
    if (!isRecord(form)) continue;
    const nested = form[field];
    if (typeof nested === "string" || typeof nested === "number") return String(nested);
  }

  const action = value.action;
  if (isRecord(action)) {
    const nested = extractStringField(action, field);
    if (nested) return nested;
  }

  return null;
}

function extractCardActionField(
  value: Record<string, unknown>,
  raw: unknown,
  field: string,
): string | null {
  return extractStringField(value, field) ?? extractStringField(raw, field);
}
