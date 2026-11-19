// Transport for Rome's own Slack app. Channel contract: docs/architecture/channels.md.
//
// One official app serves every workspace, so Slack sends its events to Rome
// Cloud, not to the instance. Rome Cloud checks Slack's signature, finds the
// instance the workspace is bound to, and deposits the event, signed with the
// workspace's forward secret, into that workspace's relay mailbox. This adapter
// drains that mailbox, checks the forward signature and the workspace, drops
// what it has already seen by Slack's event id, and delivers each direct
// message as the connection's own record. Replies go straight to Slack's Web
// API with the bot token the instance got at sign-in.
//
// Phase 1 hears direct messages only. Mentions in a group come in phase 2.

import type { ChannelMessage, ChatId, MessageReceipt, OutgoingMessage } from "@rome-os/app-runtime";
import { createLogger } from "../../../logger.js";
import { InboundDedup } from "../../inbound/inbound-dedup.js";
import { refuseAttachments, replyToShaped, textToSend } from "../../outbound/send-refusals.js";
import {
  decodeSlackText,
  isSlackCredentialError,
  parseSlackChatId,
  replyThreadOf,
  SlackApiError,
  type SlackEventCallback,
  slackMessageId,
  slackSenderId,
  type SlackUserName,
  slackUserIdOf,
  splitSlackText,
} from "../slack/slack.js";
import { isForwardedBy } from "./forward.js";
import type { SlackAppMailbox } from "./rome-cloud.js";
import type { SlackAppWebApi } from "./web-api.js";

const log = createLogger("slack-app");

const SLACK_MESSAGE_ID = /^\d+\.\d+(?::\d+\.\d+)?$/;
const USER_NAME_CACHE_SIZE = 500;

/** One frame drained from the workspace's mailbox. */
export interface MailboxFrame {
  headers: Record<string, string>;
  body: Uint8Array | null;
}

/**
 * Opens a drain on a relay mailbox. Each frame is handed to `onFrame`, whose
 * HTTP-style status says what happened to it: 2xx handled, a 4xx other than a
 * transient one dropped for good, anything else retried and then held. The
 * mailbox keeps frames while nothing drains it, so events sent while the
 * instance is stopped arrive once it starts again.
 */
export type OpenMailbox = (
  mailbox: SlackAppMailbox,
  onFrame: (frame: MailboxFrame) => Promise<{ status: number }>,
) => { stop(): Promise<void> | void };

export interface SlackAppAdapterConfig {
  /** The connection kind the channel records carry. */
  channel: string;
  botToken: string;
  teamId: string;
  botUserId: string;
  forwardSecret: string;
  mailbox: SlackAppMailbox;
  api: SlackAppWebApi;
  openMailbox: OpenMailbox;
  /** Fresh drain credentials from Rome Cloud; the drain key expires. A
   *  failure keeps the stored ones. */
  refreshMailbox?: () => Promise<SlackAppMailbox>;
  /** Keeps refreshed drain credentials with the grant. */
  onMailboxRefreshed?: (mailbox: SlackAppMailbox) => void;
  onFault?: (fault: { kind: "credential" | "transport"; cause: unknown }) => void;
}

function isExternalAuthor(payload: SlackEventCallback): boolean {
  const event = payload.event;
  return [event.team, event.user_team, event.source_team].some(
    (team) => typeof team === "string" && team !== payload.team_id,
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SlackAppAdapter {
  private handler?: (message: ChannelMessage) => void;
  private drain: { stop(): Promise<void> | void } | null = null;
  private readonly dedup = new InboundDedup(5_000);
  private readonly userNames = new Map<string, SlackUserName>();
  private abort = new AbortController();
  private appId: string | undefined;
  private mailbox: SlackAppMailbox;

  constructor(private readonly config: SlackAppAdapterConfig) {
    this.mailbox = config.mailbox;
  }

  onInbound(handler: (message: ChannelMessage) => void): void {
    this.handler = handler;
  }

  /** Checks the bot token, then drains the workspace's mailbox. Rejects when
   *  Slack refuses the token or it answers as another bot. */
  async start(): Promise<void> {
    if (this.abort.signal.aborted) this.abort = new AbortController();
    const signal = this.abort.signal;
    const identity = await this.config.api.authTest(this.config.botToken, signal);
    if (identity.teamId !== this.config.teamId || identity.botUserId !== this.config.botUserId) {
      throw new SlackApiError("app_mismatch", "The bot token answers as another Slack bot.");
    }
    if (signal.aborted) return;
    this.appId = identity.appId;
    if (this.config.refreshMailbox) {
      try {
        const fresh = await this.config.refreshMailbox();
        if (
          fresh.connectUrl !== this.mailbox.connectUrl ||
          fresh.drainKey !== this.mailbox.drainKey
        ) {
          this.mailbox = fresh;
          this.config.onMailboxRefreshed?.(fresh);
        }
      } catch (error) {
        log.warn("slack app mailbox refresh failed; draining with the stored key", {
          error: describe(error),
        });
      }
    }
    if (signal.aborted) return;
    this.drain = this.config.openMailbox(this.mailbox, (frame) => this.handleFrame(frame));
    log.info("slack app started", { teamId: this.config.teamId });
  }

  async stop(): Promise<void> {
    this.abort.abort(new Error("Slack app adapter stopped."));
    const drain = this.drain;
    this.drain = null;
    await drain?.stop();
  }

  /** Handle one drained frame. Exposed for tests. */
  async handleFrame(frame: MailboxFrame): Promise<{ status: number }> {
    const body = frame.body ?? new Uint8Array(0);
    if (
      !isForwardedBy({
        headers: frame.headers,
        body,
        forwardSecret: this.config.forwardSecret,
        teamId: this.config.teamId,
      })
    ) {
      log.warn("slack app frame dropped: not forwarded by Rome Cloud for this workspace");
      return { status: 401 };
    }
    let payload: SlackEventCallback;
    try {
      payload = JSON.parse(new TextDecoder().decode(body)) as SlackEventCallback;
    } catch {
      return { status: 400 };
    }
    // The signed header names the workspace; the body must agree.
    if (payload?.type !== "event_callback" || payload.team_id !== this.config.teamId) {
      return { status: 400 };
    }
    if (payload.api_app_id && this.appId && payload.api_app_id !== this.appId) {
      return { status: 400 };
    }
    // Slack retries and the relay delivers at least once.
    if (typeof payload.event_id !== "string" || this.dedup.checkAndRecord(payload.event_id)) {
      return { status: 200 };
    }
    await this.handleEvent(payload);
    return { status: 200 };
  }

  private async handleEvent(payload: SlackEventCallback): Promise<void> {
    const event = payload.event;
    if (event.type === "app_uninstalled") {
      this.config.onFault?.({ kind: "credential", cause: new SlackApiError(event.type) });
      return;
    }
    if (event.type === "tokens_revoked") {
      if (event.tokens?.bot?.includes(this.config.botUserId)) {
        this.config.onFault?.({ kind: "credential", cause: new SlackApiError(event.type) });
      }
      return;
    }
    if (event.type !== "message" || event.channel_type !== "im") return;
    // Slack user ids are per workspace: an author from another workspace
    // (Slack Connect) never speaks under this workspace's address.
    if (isExternalAuthor(payload)) return;
    if (event.bot_id || event.user === this.config.botUserId) return;
    if (event.subtype && event.subtype !== "file_share") return;
    if (!event.user || !event.channel || !event.ts || typeof event.text !== "string") return;
    const text = decodeSlackText(event.text, this.config.botUserId);
    if (!text) return;

    const name = await this.lookUpName(event.user);
    const message: ChannelMessage = {
      channel: this.config.channel,
      direction: "inbound",
      chatId: event.channel as ChatId,
      messageId: slackMessageId(event.ts, event.thread_ts),
      senderId: slackSenderId(payload.team_id, event.user),
      ...(name.displayName ? { senderDisplayName: name.displayName } : {}),
      ...(name.username ? { senderUsername: name.username } : {}),
      text,
      attachments: [],
      timestamp: new Date(Number.parseFloat(event.ts) * 1_000),
      raw: payload,
      ...(event.thread_ts ? { replyTo: { messageId: event.thread_ts } } : {}),
      thread: { kind: "dm" },
      addressing: "direct",
    };
    log.info("message received", { chatId: message.chatId });
    try {
      this.handler?.(message);
    } catch (error) {
      log.error("message handler error", { messageId: message.messageId, error: describe(error) });
    }
  }

  async send(chatId: ChatId, message: OutgoingMessage): Promise<MessageReceipt> {
    refuseAttachments("slack", message);
    const text = textToSend("slack", message).trim();
    const replyTo = replyToShaped("slack", message.replyToMessageId, SLACK_MESSAGE_ID);
    const parsed = parseSlackChatId(chatId);
    const threadTs = parsed.threadTs ?? replyThreadOf(parsed.channelId, replyTo);
    let firstTs: string | undefined;
    for (const chunk of splitSlackText(text)) {
      const sent = await this.config.api.postMessage(
        this.config.botToken,
        { channel: parsed.channelId, markdown: chunk, threadTs },
        this.abort.signal,
      );
      firstTs ??= sent.ts;
    }
    return { chatId, ...(firstTs ? { messageId: slackMessageId(firstTs, threadTs) } : {}) };
  }

  /** The direct-message conversation with a member of this workspace. */
  async directConversationFor(senderId: string): Promise<ChatId | null> {
    const separator = senderId.indexOf("/");
    if (separator === -1 || senderId.slice(0, separator) !== this.config.teamId) return null;
    const userId = slackUserIdOf(senderId.trim());
    if (!userId) return null;
    return (await this.config.api.openDirectMessage(
      this.config.botToken,
      userId,
      this.abort.signal,
    )) as ChatId;
  }

  /** A member's name, best effort: a failed lookup leaves the message unnamed. */
  private async lookUpName(userId: string): Promise<SlackUserName> {
    const cached = this.userNames.get(userId);
    if (cached) return cached;
    try {
      const name = await this.config.api.userName(this.config.botToken, userId, this.abort.signal);
      if (this.userNames.size >= USER_NAME_CACHE_SIZE) {
        const oldest = this.userNames.keys().next().value;
        if (oldest !== undefined) this.userNames.delete(oldest);
      }
      this.userNames.set(userId, name);
      return name;
    } catch (error) {
      if (isSlackCredentialError(error)) {
        this.config.onFault?.({ kind: "credential", cause: error });
      }
      log.warn("slack user lookup failed", { error: describe(error) });
      return {};
    }
  }
}
