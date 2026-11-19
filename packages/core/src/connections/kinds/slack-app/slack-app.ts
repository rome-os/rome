// Transport for Rome's own Slack app. Channel contract: docs/architecture/channels.md.
//
// One official app serves every workspace, so Slack sends its events to Rome
// Cloud, not to the instance. Rome Cloud checks Slack's signature, finds the
// instance the workspace is bound to, and deposits the event, signed with the
// workspace's forward secret, into that workspace's relay mailbox. This adapter
// drains that mailbox, checks the forward signature and the workspace, drops
// what it has already seen by Slack's event id, and delivers each direct
// message, and each mention of the app in a group, as the connection's own
// record. Replies go straight to Slack's Web API with the bot token the
// instance got at sign-in; a reply to a mention goes in a thread under it.

import type { ChannelMessage, ChatId, MessageReceipt, OutgoingMessage } from "@rome-os/app-runtime";
import { createLogger } from "../../../logger.js";
import { InboundDedup } from "../../inbound/inbound-dedup.js";
import { refuseAttachments, replyToShaped, textToSend } from "../../outbound/send-refusals.js";
import type { TalkHistoryRead } from "../../types.js";
import {
  isSlackCredentialError,
  parseSlackChatId,
  replyThreadOf,
  SlackApiError,
  type SlackEvent,
  type SlackEventCallback,
  slackMessageId,
  type SlackUserName,
  slackUserIdOf,
  splitSlackText,
} from "../slack/slack.js";
import { isForwardedBy } from "./forward.js";
import { authorOf, inTimeline, isSaid, slackMessage, type SlackWireMessage } from "./message.js";
import { SlackReadGate } from "./read-gate.js";
import { noteInDrain, readTimeline, type SlackTimelineDeps } from "./timeline.js";
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
/** How long a history read waits for its authors' names. */
const NAME_WAIT_MS = 3_000;
/** How long after a removal event the token it outlived is looked at again. */
const REMOVAL_RECHECK_MS = 30_000;

/** Slack's allowance for conversations.history: one request a minute in a
 *  workspace, of at most 15 messages. */
const HISTORY_INTERVAL_MS = 60 * 1000;
const HISTORY_PAGE = 15;
/** The longest a read holds its turn waiting for Slack's next request. */
const HISTORY_MAX_WAIT_MS = 60 * 1000;
/** What a search covers, as its result says. */
export const SEARCH_COVERAGE =
  "The messages Rome's Slack app holds in this workspace: its direct messages and the messages that mention it, as Rome heard or read them. This is not a workspace-wide search: other channels, messages from before the app joined, and messages from before Rome's copy was last cleared are not covered.";
/** What a search in one chat covers, once the chat's newest messages are read. */
export const SEARCH_CHAT_COVERAGE =
  "This chat as Rome holds it, after reading its newest messages from Slack: older messages count only where Rome heard or read them before.";
/** What a search covers in a chat the app may not read. */
export const SEARCH_UNREADABLE_CHAT_COVERAGE =
  "The messages in this chat that mention Rome's Slack app, as Rome heard them: the app may not read the chat's history.";
/** Slack's refusals that mean the app may not read a conversation. */
const NOT_READABLE = new Set(["channel_not_found", "not_in_channel", "missing_scope"]);
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
  /** Keeps refreshed drain credentials with the grant. */
  onMailboxRefreshed?: (mailbox: SlackAppMailbox) => void;
  onFault?: (fault: { kind: "credential" | "transport"; cause: unknown }) => void;
  /** The connection's own copy of the direct messages it hears. */
  copy: SlackMessageCopy;
  /** Now, for the copy's times. */
  now?: () => Date;
  /** How reads of Slack's history take turns. Defaults to Slack's allowance. */
  readGate?: SlackReadGate;
}

/** A `message_changed` or `message_deleted` event, in the fields read here. */
type SlackChangeEvent = SlackEvent & {
  /** The message as edited. */
  message?: SlackWireMessage;
  /** The deleted message's ts. */
  deleted_ts?: string;
  /** When Slack made the change. */
  event_ts?: string;
};

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
  /** A second look at the token after a removal event it outlived. */
  private recheckTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly readGate: SlackReadGate;
  /** The newest message heard in each direct message since the drain opened. */
  private readonly heads = new Map<string, string>();
  /** Whether a drain is open, so what it delivers is heard in it. */
  private draining = false;
  /** The app's posts in each direct message that Slack has not sent back as
   *  events yet. Until it does, and while a send waits on Slack's answer, the
   *  drain does not know the chat's newest message, so a read asks Slack. */
  private readonly unheardPosts = new Map<string, Set<string>>();
  /** Posts still waiting on Slack's answer in each direct message, with the
   *  ones whose event came back before that answer did. */
  private readonly posting = new Map<string, { sends: number; heard: Set<string> }>();

  constructor(private readonly config: SlackAppAdapterConfig) {
    this.mailbox = config.mailbox;
    this.readGate =
      config.readGate ??
      new SlackReadGate({ intervalMs: HISTORY_INTERVAL_MS, maxWaitMs: HISTORY_MAX_WAIT_MS });
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
    // A new drain: what came before it is a break in every chat's timeline.
    this.heads.clear();
    this.unheardPosts.clear();
    this.posting.clear();
    this.draining = true;
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
    this.mailbox = fresh;
    this.config.onMailboxRefreshed?.(fresh);
    return true;
  }

  private keyExpired(): boolean {
    const expiry = drainKeyExpiry(this.mailbox.drainKey);
    return expiry !== null && expiry <= Date.now();
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
      this.scheduleRenewal();
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
    this.clearRecheck();
    const drain = this.drain;
    this.drain = null;
    await drain?.stop();
    this.draining = false;
    this.heads.clear();
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
    // A direct message arrives as `message` in an `im`. In a group the app
    // hears only what mentions it, as `app_mention`; Slack sends no other
    // group message, and one that came anyway is neither answered nor kept.
    const direct = event.type === "message" && event.channel_type === "im";
    const mention =
      event.type === "app_mention" &&
      event.channel_type !== "im" &&
      typeof event.channel === "string" &&
      !event.channel.startsWith("D");
    if (event.type !== "message" && event.type !== "app_mention") {
      // Slack retries and the relay delivers at least once.
      if (this.dedup.checkAndRecord(eventId)) return { status: 200 };
      await this.handleSignal(payload);
      return { status: 200 };
    }
    if (!direct && !mention) return { status: 200 };
    if (!event.channel || !event.ts) return { status: 200 };
    if (direct && (event.subtype === "message_changed" || event.subtype === "message_deleted")) {
      return this.handleChange(event as SlackChangeEvent, event.channel);
    }
    const wire: SlackWireMessage = { ...event, ts: event.ts };
    // Slack sends the app an event for each of its own posts. Those are
    // matched on the bot's own user from the install, not on any bot id, so
    // another bot that mentions the app is still heard. In a direct message
    // the app hears every message, its own too, so its own post still shows
    // the drain what comes after what there; it is never handed over.
    if (event.user === this.config.botUserId) {
      if (direct) {
        this.noteHeard(event.channel, wire);
        this.postHeard(event.channel, event.ts);
      }
      return { status: 200 };
    }
    // Slack user ids are per workspace: an author from another workspace
    // (Slack Connect) never speaks under this workspace's address.
    // Slack's history still shows such a message, so the drain's timeline
    // breaks there rather than linking across it.
    if (isExternalAuthor(payload)) {
      return direct ? this.breakAt(event.channel, wire) : { status: 200 };
    }
    // A bot or workflow that mentions the app posts as a bot_message, often
    // with no user: the bot is its author. Only a mention is taken from one,
    // since the app's own posts are told apart by their user.
    if (!isSaid(event.subtype)) return { status: 200 };
    const author = event.user ?? (mention ? authorOf(event) : undefined);
    if (!author || typeof event.text !== "string") {
      // Slack's history still shows a bot's post Rome does not hear, so the
      // drain's timeline breaks there rather than linking across it.
      return direct ? this.breakAt(event.channel, wire) : { status: 200 };
    }
    const said = slackMessage(this.context(event.channel), wire);
    if (!said) return { status: 200 };

    const name = event.user ? await this.lookUpName(event.user) : {};
    const message: ChannelMessage = {
      ...said,
      ...(name.displayName ? { senderDisplayName: name.displayName } : {}),
      ...(name.username ? { senderUsername: name.username } : {}),
      raw: payload,
      // A thread lives inside its conversation's chat. The reply finds the
      // thread from the id of the message it answers.
      ...(event.thread_ts ? { replyTo: { messageId: event.thread_ts } } : {}),
      addressing: direct ? "direct" : "mention",
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
          userId: author,
          text: message.text,
          message,
        },
        this.now(),
      );
    } catch (error) {
      log.error("slack app could not keep a message", { error: describe(error) });
      this.config.onFault?.({ kind: "transport", cause: error });
      return { status: 500 };
    }
    if (direct) this.noteHeard(event.channel, wire, message);
    if (!fresh) return { status: 200 };
    log.info("message received", { chatId: message.chatId });
    this.handOver(eventId, message);
    return { status: 200 };
  }

  /**
   * An edit or a deletion in a direct message, taken into the copy so a read
   * or a search shows the message as Slack now does. A message edited into
   * one nobody said, such as a deleted message whose thread keeps a tombstone,
   * is gone as a deleted one is. In a group the app hears no edit, since Slack
   * sends it only the messages that mention it. A write that fails answers
   * 500, and the mailbox delivers the event again.
   */
  private handleChange(event: SlackChangeEvent, channelId: string): { status: number } {
    const ts = event.subtype === "message_deleted" ? event.deleted_ts : event.message?.ts;
    if (!ts) return { status: 200 };
    const edited =
      event.subtype === "message_changed" && event.message
        ? slackMessage(this.context(channelId), { ...event.message, ts })
        : null;
    // An edit is stamped with the ts Slack gives it, as a history page shows
    // it too, and any other change with the event's own ts: a retried or late
    // change older than one the copy took changes nothing.
    const changedTs =
      (edited ? event.message?.edited?.ts : undefined) ?? event.event_ts ?? event.ts;
    if (!changedTs) return { status: 200 };
    try {
      this.config.copy.change(this.config.teamId, channelId, ts, {
        changedTs,
        text: edited ? edited.text : null,
      });
    } catch (error) {
      log.error("slack app could not take an edit into its copy", { error: describe(error) });
      this.config.onFault?.({ kind: "transport", cause: error });
      return { status: 500 };
    }
    // The chat's newest is unknown once it is gone, until a read asks Slack.
    if (!edited && this.heads.get(channelId) === ts) this.heads.delete(channelId);
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
    if (await this.tokenRefused()) return;
    log.info("slack app's token outlived a removal event", { event: event.type });
    // Slack may take back the token a moment after it reports the removal,
    // so the token is looked at once more. One that still works is a token
    // minted since, by connecting again, which the event came before.
    if (this.recheckTimer) return;
    const signal = this.abort.signal;
    this.recheckTimer = setTimeout(() => {
      this.recheckTimer = null;
      if (!signal.aborted) void this.tokenRefused();
    }, REMOVAL_RECHECK_MS);
    this.recheckTimer.unref?.();
  }

  /** Whether Slack refuses the token now, reported as the connection's fault. */
  private async tokenRefused(): Promise<boolean> {
    const signal = this.abort.signal;
    try {
      await this.config.api.authTest(this.config.botToken, signal);
      return false;
    } catch (error) {
      if (signal.aborted) return true;
      this.config.onFault?.({
        kind: isSlackCredentialError(error) ? "credential" : "transport",
        cause: error,
      });
      return true;
    }
  }

  private clearRecheck(): void {
    if (this.recheckTimer) clearTimeout(this.recheckTimer);
    this.recheckTimer = null;
  }

  async send(chatId: ChatId, message: OutgoingMessage): Promise<MessageReceipt> {
    refuseAttachments("slack", message);
    const text = textToSend("slack", message).trim();
    const replyTo = replyToShaped("slack", message.replyToMessageId, SLACK_MESSAGE_ID);
    const parsed = parseSlackChatId(chatId);
    const threadTs = parsed.threadTs ?? replyThreadOf(parsed.channelId, replyTo);
    let firstTs: string | undefined;
    for (const chunk of splitSlackText(text)) {
      // The post joins the drain's timeline from its own event, which Slack
      // sends in order with what others said: a send's answer shows nothing
      // of what was said just before it. The event can come before the answer.
      const awaited = !threadTs && parsed.channelId.startsWith("D");
      if (awaited) this.beginPost(parsed.channelId);
      let sent: { ts: string } | undefined;
      try {
        sent = await this.config.api.postMessage(
          this.config.botToken,
          { channel: parsed.channelId, markdown: chunk, threadTs },
          this.abort.signal,
        );
      } finally {
        if (awaited) this.endPost(parsed.channelId, sent?.ts);
      }
      firstTs ??= sent.ts;
    }
    return { chatId, ...(firstTs ? { messageId: slackMessageId(firstTs, threadTs) } : {}) };
  }

  private context(chatId: string) {
    return {
      channel: this.config.channel,
      teamId: this.config.teamId,
      botUserId: this.config.botUserId,
      chatId,
    };
  }

  private timeline(): SlackTimelineDeps {
    return {
      teamId: this.config.teamId,
      copy: this.config.copy,
      heads: this.heads,
      hearsEvery: (channelId) =>
        this.draining &&
        channelId.startsWith("D") &&
        !this.unheardPosts.has(channelId) &&
        !this.posting.has(channelId),
      fetchPage: (channelId, bounds) =>
        this.readGate.run(
          `${channelId}:${bounds.latest ?? ""}`,
          () => this.fetchPage(channelId, bounds.latest),
          this.abort.signal,
        ),
    };
  }

  /** Break a direct message's timeline at `wire`, a message Slack's history
   *  shows that the connection does not keep: the drain links nothing across
   *  it, and a link the copy already holds across it, written before it
   *  arrived late, is forgotten. A write that fails answers 500, and the
   *  mailbox delivers the event again. */
  private breakAt(channelId: string, wire: SlackWireMessage): { status: number } {
    this.heads.delete(channelId);
    if (!inTimeline(wire)) return { status: 200 };
    try {
      this.config.copy.unlinkAcross(this.config.teamId, channelId, wire.ts);
    } catch (error) {
      log.error("slack app could not break its timeline", { error: describe(error) });
      this.config.onFault?.({ kind: "transport", cause: error });
      return { status: 500 };
    }
    return { status: 200 };
  }

  /** Note a direct message's timeline message heard in this drain. A failure
   *  leaves a break, which a read takes from Slack. */
  private noteHeard(channelId: string, wire: SlackWireMessage, said?: ChannelMessage): void {
    if (!this.draining || !inTimeline(wire)) return;
    const message = said ?? slackMessage(this.context(channelId), wire);
    if (!message) return;
    try {
      // A message deleted since, heard again because Slack retried it, is
      // not in Slack's history: the drain links across it.
      if (this.config.copy.deleted(this.config.teamId, channelId, wire.ts)) return;
      const { raw: _raw, addressing: _addressing, ...kept } = message;
      noteInDrain(this.timeline(), channelId, wire.ts, kept);
    } catch (error) {
      // The message is missing from the timeline, so the next one heard must
      // not link across it.
      this.heads.delete(channelId);
      log.warn("slack app could not note a message in its timeline", { error: describe(error) });
    }
  }

  private beginPost(channelId: string): void {
    const posting = this.posting.get(channelId) ?? { sends: 0, heard: new Set<string>() };
    posting.sends += 1;
    this.posting.set(channelId, posting);
  }

  /** Note a send's answer: its post waits for its event unless that came
   *  first. Posts heard early are forgotten once no send waits, since only a
   *  waiting one can claim them. */
  private endPost(channelId: string, ts: string | undefined): void {
    const posting = this.posting.get(channelId);
    if (ts !== undefined && !posting?.heard.has(ts)) {
      const posts = this.unheardPosts.get(channelId) ?? new Set<string>();
      posts.add(ts);
      this.unheardPosts.set(channelId, posts);
    }
    if (posting && --posting.sends === 0) this.posting.delete(channelId);
  }

  private postHeard(channelId: string, ts: string): void {
    const posts = this.unheardPosts.get(channelId);
    if (!posts?.delete(ts)) {
      this.posting.get(channelId)?.heard.add(ts);
      return;
    }
    if (posts.size === 0) this.unheardPosts.delete(channelId);
  }

  private async fetchPage(channelId: string, latest: string | undefined) {
    const page = await this.config.api.conversationHistory(
      this.config.botToken,
      { channel: channelId, ...(latest ? { latest } : {}), limit: HISTORY_PAGE },
      this.abort.signal,
    );
    const wires = page.messages.filter(inTimeline);
    const names = await this.namesOf(
      wires.flatMap((wire) =>
        wire.user && wire.user !== this.config.botUserId ? [wire.user] : [],
      ),
    );
    const messages: Array<{ ts: string; message: ChannelMessage; editedTs?: string }> = [];
    for (const wire of wires) {
      const name = (wire.user && names.get(wire.user)) || {};
      const message = slackMessage(this.context(channelId), wire, name);
      if (message) {
        messages.push({
          ts: wire.ts,
          message,
          ...(wire.edited?.ts ? { editedTs: wire.edited.ts } : {}),
        });
      }
    }
    return { messages, hasMore: page.hasMore, oldest: page.messages.at(-1)?.ts };
  }

  /**
   * The messages of a chat's timeline within `read`'s bounds, newest first.
   * Replies inside a thread are not in it. Rejects naming the chat when the
   * app may not read it.
   */
  async readHistory(chatId: ChatId, read: TalkHistoryRead): Promise<ChannelMessage[]> {
    // A broadcast reply's id names its thread too, as `<thread ts>:<ts>`; its
    // place in the timeline is its own ts.
    const bound = (field: "olderThan" | "newerThan", id: string | undefined) => {
      if (id === undefined) return undefined;
      const match = /^(?:\d+\.\d+:)?(\d+\.\d+)$/.exec(id);
      if (!match) {
        throw new Error(
          `${field} "${id}" is no Slack message id here: one looks like 1700000000.000100`,
        );
      }
      return match[1];
    };
    const olderThan = bound("olderThan", read.olderThan);
    const newerThan = bound("newerThan", read.newerThan);
    read = {
      ...read,
      ...(olderThan ? { olderThan } : {}),
      ...(newerThan ? { newerThan } : {}),
    };
    const { channelId, threadTs } = parseSlackChatId(chatId);
    if (threadTs)
      throw new Error(`Slack chat ${chatId} is a thread, and a read takes its conversation's id`);
    try {
      return await readTimeline(this.timeline(), channelId as ChatId, read);
    } catch (error) {
      if (error instanceof SlackApiError && NOT_READABLE.has(error.code)) {
        throw new Error(`This Slack account may not read chat ${chatId} (${error.code})`);
      }
      throw error;
    }
  }

  /**
   * Messages whose text holds `text`, newest first, from what this connection
   * keeps: every direct message and mention it heard, and every timeline
   * message it read. A search in one chat reads that chat first, as a read
   * would, so it takes what Slack holds that the copy lacks. A search across
   * chats reads none: Slack lets the app read a conversation's history one
   * page of 15 a minute, and the app holds no search scope.
   */
  async search(input: { text: string; chatId?: ChatId; limit: number }): Promise<{
    messages: ChannelMessage[];
    coverage: string;
  }> {
    let coverage = SEARCH_COVERAGE;
    let channelId: string | undefined;
    if (input.chatId) {
      const parsed = parseSlackChatId(input.chatId);
      channelId = parsed.channelId;
      coverage = await this.fillForSearch(parsed.channelId);
    }
    const messages = this.config.copy.search(this.config.teamId, {
      text: input.text,
      ...(channelId ? { channelId } : {}),
      limit: input.limit,
    });
    return { messages, coverage };
  }

  /** Read a chat's newest messages into the copy before searching it, and
   *  say what the search then covers. A chat the app may not read, such as a
   *  channel it is only mentioned in, is searched in what it heard. */
  private async fillForSearch(channelId: string): Promise<string> {
    try {
      await readTimeline(this.timeline(), channelId as ChatId, { limit: HISTORY_PAGE });
      return SEARCH_CHAT_COVERAGE;
    } catch (error) {
      if (error instanceof SlackApiError && NOT_READABLE.has(error.code)) {
        return SEARCH_UNREADABLE_CHAT_COVERAGE;
      }
      throw error;
    }
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
  /** The names of `authors`, each looked up once and all together. A page is
   *  answered without the names Slack has not given within
   *  {@link NAME_WAIT_MS}, so a slow lookup never holds up a read. */
  private async namesOf(authors: readonly string[]): Promise<Map<string, SlackUserName>> {
    const unique = [...new Set(authors)];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), NAME_WAIT_MS);
    });
    try {
      const named = await Promise.all(
        unique.map(
          async (id) => [id, (await Promise.race([this.lookUpName(id), late])) ?? {}] as const,
        ),
      );
      return new Map(named);
    } finally {
      clearTimeout(timer);
    }
  }

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
