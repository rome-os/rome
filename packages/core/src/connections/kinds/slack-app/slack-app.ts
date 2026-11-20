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
import type { SlackMessageCopy } from "./message-copy.js";

export type { SlackMessageCopy } from "./message-copy.js";
import type { SlackAppMailbox } from "./rome-cloud.js";
import type { SlackAppWebApi } from "./web-api.js";

const log = createLogger("slack-app");

const SLACK_MESSAGE_ID = /^\d+\.\d+(?::\d+\.\d+)?$/;
const USER_NAME_CACHE_SIZE = 500;
const HOUR_MS = 60 * 60 * 1000;
/** Renew the drain key this long before it expires. Rome Cloud issues 90-day keys. */
const RENEW_BEFORE_EXPIRY_MS = 7 * 24 * HOUR_MS;
const RENEW_RETRY_MS = HOUR_MS;
/** A message handed to Rome this soon before the last hand-off is handed over
 *  again on start: handing over does not wait for Rome to record it, so a
 *  stop may have cut it off. Rome ignores a message it already holds. */
const HAND_OVER_AGAIN_MS = 15 * 60 * 1000;
/** Under setTimeout's 24.8-day ceiling; a longer wait is taken in steps. */
const MAX_TIMER_MS = 24 * HOUR_MS;

/** When a drain key `<exp>.<sig>` stops working, in epoch ms, or null when the
 *  key does not say. */
export function drainKeyExpiry(drainKey: string): number | null {
  const match = /^(\d+)\./.exec(drainKey);
  return match ? Number(match[1]) * 1_000 : null;
}

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
  /** Keeps refreshed drain credentials with the grant. The adapter drains
   *  with them only once this resolves: the relay retires an older key once a
   *  newer one connects, so a key it drained with but did not keep would
   *  leave a restart with a refused one. */
  onMailboxRefreshed?: (mailbox: SlackAppMailbox) => Promise<void>;
  onFault?: (fault: { kind: "credential" | "transport"; cause: unknown }) => void;
  /** The connection's own copy of the direct messages it hears. */
  copy: SlackMessageCopy;
  /** Whether Rome listens to the account now. A message heard while it does
   *  not is neither kept nor handed over, so linking an agent later brings
   *  none of it back (docs/domains/chats.md). Absent, Rome always listens. */
  listened?: () => boolean;
  /** Now, for the copy's times. */
  now?: () => Date;
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
  private renewTimer: ReturnType<typeof setTimeout> | null = null;

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
        await this.refreshMailbox(signal);
      } catch (error) {
        log.warn("slack app mailbox refresh failed; draining with the stored key", {
          error: describe(error),
        });
      }
    }
    if (signal.aborted) return;
    // The relay refuses an expired key on every reconnect, so draining with
    // one would look connected and hear nothing. Failing the start hands the
    // retry to the runtime, which starts again after a backoff.
    if (this.keyExpired()) {
      throw new Error("The Slack mailbox key expired and Rome Cloud could not renew it.");
    }
    this.handOverKept();
    this.drain = this.config.openMailbox(this.mailbox, (frame) => this.handleFrame(frame));
    this.scheduleRenewal();
    log.info("slack app started", { teamId: this.config.teamId });
  }

  /** Ask Rome Cloud for drain credentials; true when they changed. An answer
   *  that lands after `signal` aborted belongs to a stopped adapter, whose
   *  grant may already be replaced, so it is dropped without persisting. */
  private async refreshMailbox(signal: AbortSignal): Promise<boolean> {
    const fresh = await this.config.refreshMailbox?.();
    if (
      signal.aborted ||
      !fresh ||
      (fresh.connectUrl === this.mailbox.connectUrl && fresh.drainKey === this.mailbox.drainKey)
    ) {
      return false;
    }
    await this.config.onMailboxRefreshed?.(fresh);
    if (signal.aborted) return false;
    this.mailbox = fresh;
    return true;
  }

  private keyExpired(): boolean {
    const expiry = drainKeyExpiry(this.mailbox.drainKey);
    return expiry !== null && expiry <= Date.now();
  }

  private renewalDue(): boolean {
    const expiry = drainKeyExpiry(this.mailbox.drainKey);
    return expiry !== null && expiry - RENEW_BEFORE_EXPIRY_MS <= Date.now();
  }

  /** Renew the drain key a week before it expires, while the drain runs. */
  private scheduleRenewal(delayMs?: number): void {
    this.clearRenewal();
    if (!this.config.refreshMailbox || this.abort.signal.aborted) return;
    let wait = delayMs;
    if (wait === undefined) {
      const expiry = drainKeyExpiry(this.mailbox.drainKey);
      if (expiry === null) return;
      wait = Math.max(0, expiry - RENEW_BEFORE_EXPIRY_MS - Date.now());
    }
    const due = Date.now() + wait;
    this.renewTimer = setTimeout(
      () => {
        this.renewTimer = null;
        if (Date.now() < due) this.scheduleRenewal(due - Date.now());
        else void this.renew();
      },
      Math.min(wait, MAX_TIMER_MS),
    );
  }

  private async renew(): Promise<void> {
    const signal = this.abort.signal;
    try {
      const changed = await this.refreshMailbox(signal);
      if (signal.aborted) return;
      if (changed) {
        // The old drain finishes the frame it is delivering before the new one
        // opens, so a message cannot overtake the one before it.
        const old = this.drain;
        this.drain = null;
        await old?.stop();
        if (signal.aborted) return;
        this.drain = this.config.openMailbox(this.mailbox, (frame) => this.handleFrame(frame));
        log.info("slack app mailbox key renewed", { teamId: this.config.teamId });
      }
      // A key Rome Cloud answered that is already due again, the same one or
      // a short-lived one, waits for the retry rather than asking at once.
      this.scheduleRenewal(this.renewalDue() ? RENEW_RETRY_MS : undefined);
    } catch (error) {
      if (signal.aborted) return;
      log.warn("slack app mailbox renewal failed; will retry", { error: describe(error) });
      if (this.keyExpired()) {
        this.config.onFault?.({ kind: "transport", cause: error });
        return;
      }
      this.scheduleRenewal(RENEW_RETRY_MS);
    }
  }

  private clearRenewal(): void {
    if (this.renewTimer) clearTimeout(this.renewTimer);
    this.renewTimer = null;
  }

  async stop(): Promise<void> {
    this.abort.abort(new Error("Slack app adapter stopped."));
    this.clearRenewal();
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
    if (typeof payload.event_id !== "string") return { status: 200 };
    return this.handleEvent(payload, payload.event_id);
  }

  /** Hand Rome again what it may not hold: what the copy kept but never
   *  handed over, and what it handed over just before it last stopped,
   *  however long ago. Rome ignores a message it already holds. */
  private handOverKept(): void {
    const kept = this.config.copy.mayNotHold(this.config.teamId, HAND_OVER_AGAIN_MS);
    if (kept.length > 0) {
      log.info("slack app handing over kept messages", { count: kept.length });
    }
    for (const { eventId, message } of kept) {
      this.handOver(eventId, { ...message, channel: this.config.channel });
    }
  }

  /** Hand `message` to Rome without waiting on it, and note it was handed. */
  private handOver(eventId: string, message: ChannelMessage): void {
    if (!this.handler) return;
    try {
      this.handler(message);
    } catch (error) {
      log.error("message handler error", { messageId: message.messageId, error: describe(error) });
    }
    this.config.copy.handedOver(this.config.teamId, eventId, this.now());
  }

  private now(): Date {
    return this.config.now?.() ?? new Date();
  }

  private async handleEvent(
    payload: SlackEventCallback,
    eventId: string,
  ): Promise<{ status: number }> {
    const event = payload.event;
    if (event.type !== "message") {
      // Slack retries and the relay delivers at least once.
      if (this.dedup.checkAndRecord(eventId)) return { status: 200 };
      await this.handleSignal(payload);
      return { status: 200 };
    }
    if (event.channel_type !== "im") return { status: 200 };
    // Slack user ids are per workspace: an author from another workspace
    // (Slack Connect) never speaks under this workspace's address.
    if (isExternalAuthor(payload)) return { status: 200 };
    if (event.bot_id || event.user === this.config.botUserId) return { status: 200 };
    if (event.subtype && event.subtype !== "file_share") return { status: 200 };
    if (!event.user || !event.channel || !event.ts || typeof event.text !== "string") {
      return { status: 200 };
    }
    const text = decodeSlackText(event.text, this.config.botUserId);
    if (!text) return { status: 200 };
    if (this.config.listened && !this.config.listened()) return { status: 200 };

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
    // The mailbox is told the message was received only once the copy holds
    // it: a write that fails answers 500, and the mailbox delivers it again.
    // The drain gives up on a frame after a few retries and waits to be
    // resumed, so the failure also reports the connection down: the runtime
    // starts it again after a backoff, with a fresh drain that retries the
    // frame. An event the copy holds already is a redelivery.
    let fresh: boolean;
    try {
      fresh = this.config.copy.keep(
        {
          teamId: payload.team_id,
          eventId,
          channelId: event.channel,
          ts: event.ts,
          ...(event.thread_ts ? { threadTs: event.thread_ts } : {}),
          userId: event.user,
          text,
          message,
        },
        this.now(),
      );
    } catch (error) {
      log.error("slack app could not keep a message", { error: describe(error) });
      this.config.onFault?.({ kind: "transport", cause: error });
      return { status: 500 };
    }
    if (!fresh) return { status: 200 };
    log.info("message received", { chatId: message.chatId });
    this.handOver(eventId, message);
    return { status: 200 };
  }

  /**
   * An event that is not a message: the app removed or its token revoked.
   * Such an event can wait in the mailbox while Rome is stopped and arrive
   * after the guardian connected again with a new token, so it ends the
   * connection only when Slack refuses the token now. A check that cannot
   * reach Slack reports the connection down, and the restart checks again.
   */
  private async handleSignal(payload: SlackEventCallback): Promise<void> {
    const event = payload.event;
    const removed =
      event.type === "app_uninstalled" ||
      (event.type === "tokens_revoked" && !!event.tokens?.bot?.includes(this.config.botUserId));
    if (!removed) return;
    try {
      await this.config.api.authTest(this.config.botToken, this.abort.signal);
      log.info("slack app's token outlived a removal event", { event: event.type });
    } catch (error) {
      this.config.onFault?.({
        kind: isSlackCredentialError(error) ? "credential" : "transport",
        cause: error,
      });
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
