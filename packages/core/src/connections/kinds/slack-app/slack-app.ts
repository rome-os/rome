// Transport for Rome's own Slack app. Channel contract: docs/architecture/channels.md.
//
// One official app serves every workspace, so Slack sends its events to the
// Slack gateway Worker, not to the instance. The Worker checks Slack's
// signature, finds the instance the workspace is bound to, and deposits the
// event, signed with that instance's deposit key, into the instance's relay
// mailbox. The mailbox's drain hands each frame here: the signature and the
// workspace are checked, and each direct message, and each mention of the app
// in a group, goes to Rome. The mailbox is told it arrived only once Chats has
// it on record. The connection keeps no record of its own. Replies and reads go
// to the Worker, which holds the bot token and calls Slack's Web API; a reply
// to a mention goes in a thread under it.

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
  type SlackEventCallback,
  slackMessageId,
  slackSenderId,
  slackUserIdOf,
  splitSlackText,
} from "../slack/slack.js";
import { isDepositedFor } from "./deposit.js";
import {
  authorOf,
  inTimeline,
  isSaid,
  type SlackMember,
  slackMessage,
  type SlackWireMessage,
} from "./message.js";
import { SlackReadGate } from "./read-gate.js";
import { type FetchHistoryPage, readTimeline } from "./timeline.js";
import { SlackMemberChannels } from "./channels.js";
import { compareTs } from "./timeline-order.js";
import type { SlackAppWebApi, SlackChannel } from "./web-api.js";
import type { Message } from "../../message.js";
import { RecordingStopped } from "../../types.js";

const log = createLogger("slack-app");

const SLACK_MESSAGE_ID = /^\d+\.\d+(?::\d+\.\d+)?$/;
/** Slack's names for the emoji the Concierge reacts with (CONCIERGE_REACTIONS). */
const SLACK_EMOJI_NAMES: Readonly<Record<string, string>> = {
  "👍": "+1",
  "✅": "white_check_mark",
  "❤️": "heart",
  "🙏": "pray",
  "😂": "joy",
  "🎉": "tada",
  "🤔": "thinking_face",
  // The status Rome shows on a message, not one the Concierge picks.
  "👀": "eyes",
  "⚠️": "warning",
};
const USER_NAME_CACHE_SIZE = 500;
/** How long a history read waits for its authors' names. */
const NAME_WAIT_MS = 3_000;

/** Slack's allowance for conversations.history: one request a minute in a
 *  workspace, of at most 15 messages. */
const HISTORY_INTERVAL_MS = 60 * 1000;
const HISTORY_PAGE = 15;
/** The longest a read holds its turn waiting for Slack's next request. */
const HISTORY_MAX_WAIT_MS = 60 * 1000;
/** Slack's refusals that mean the app may not read a conversation. */
const NOT_READABLE = new Set(["channel_not_found", "not_in_channel", "missing_scope"]);

/** One frame drained from the instance's mailbox. */
export interface MailboxFrame {
  headers: Record<string, string>;
  body: Uint8Array | null;
}

export interface SlackAppAdapterConfig {
  /** The connection kind the channel records carry. */
  channel: string;
  teamId: string;
  botUserId: string;
  /** The key the Worker signs this instance's deposits with. */
  depositKey: string;
  api: SlackAppWebApi;
  /** Whether the Worker still holds the workspace for this instance. Asked
   *  when Slack reports the app removed. */
  bound: () => Promise<boolean>;
  /** The most times the mailbox's drain delivers one frame before it drops
   *  it. */
  deliveryAttempts: number;
  onFault?: (fault: { kind: "credential" | "transport"; cause: unknown }) => void;
  /** How reads of Slack's history take turns. Defaults to Slack's allowance. */
  readGate?: SlackReadGate;
  /** How reads of a thread take turns. Slack allows conversations.replies
   *  its own request a minute, apart from conversations.history. Defaults to
   *  `readGate` when one is given, else to Slack's allowance. */
  repliesGate?: SlackReadGate;
}

/** What a read of a channel says when the workspace was connected before
 *  Rome's Slack app asked to read channels. */
export const REAPPROVE_FOR_HISTORY =
  "Rome's Slack app may not read channels in this workspace yet: it was connected before the app asked for that. Ask the guardian to approve the app again from Slack in Settings › Connections.";

/** A read's failure as an agent reads it: a chat the app may not read named,
 *  with what would let it. */
function unreadable(error: unknown, chatId: string): unknown {
  if (!(error instanceof SlackApiError) || !NOT_READABLE.has(error.code)) return error;
  if (error.code === "missing_scope") {
    return new Error(
      `This Slack account may not read chat ${chatId} (missing_scope). ${REAPPROVE_FOR_HISTORY}`,
    );
  }
  if (error.code === "not_in_channel") {
    return new Error(
      `Rome's Slack app is not a member of chat ${chatId}, so it may not read it (not_in_channel). Someone in Slack can add it with /invite.`,
    );
  }
  return new Error(`This Slack account may not read chat ${chatId} (${error.code})`);
}

/** The message's own ts: a reply's id names its thread first. */
function tsOfId(messageId: string | undefined): string {
  return messageId ? messageId.slice(messageId.lastIndexOf(":") + 1) : "";
}

/** Whether a message said at `ts` is within a read's bounds. */
function withinRead(ts: string, read: TalkHistoryRead): boolean {
  const at = Number.parseFloat(ts) * 1_000;
  if (read.since && at < read.since.getTime()) return false;
  if (read.until && at > read.until.getTime()) return false;
  if (read.olderThan && compareTs(ts, read.olderThan) >= 0) return false;
  if (read.newerThan && compareTs(ts, read.newerThan) <= 0) return false;
  return true;
}

/**
 * The connection's `Message` for `kept`, a message as the connection reads
 * it, said to the bot account `receivedBy`. Platform facts only: Rome works out whom it
 * addresses (docs/domains/connections.md#message). The app hears a group only
 * when it is mentioned, so a mention lists the bot's account; no other account
 * a message mentions is listed.
 */
export function messageOf(kept: ChannelMessage, receivedBy: string): Message {
  const direct = kept.thread?.kind === "dm";
  return {
    id: kept.messageId,
    where: {
      chatId: kept.chatId,
      kind: direct ? "direct" : "group",
      // A reply in a group's thread. The thread lives inside the chat, so the
      // chat stays the conversation and the thread is named by its own id.
      ...(kept.inThread ? { thread: { parentChatId: kept.chatId, id: kept.inThread } } : {}),
    },
    sender: {
      accountId: kept.senderId,
      ...(kept.senderDisplayName !== undefined ? { name: kept.senderDisplayName } : {}),
      ...(kept.senderUsername !== undefined ? { handle: kept.senderUsername } : {}),
    },
    content: { text: kept.text, attachments: kept.attachments },
    receivedBy,
    mentions: direct ? [] : [receivedBy],
    ...(kept.replyTo ? { replyTo: { messageId: kept.replyTo.messageId } } : {}),
    saidAt: kept.timestamp,
    ...(kept.raw !== undefined ? { raw: kept.raw } : {}),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SlackAppAdapter {
  private handler?: (message: Message) => void | Promise<void>;
  /** How many times in a row each frame not yet acknowledged was refused
   *  because recording stopped, by its event id. Kept so a refusal that
   *  outlasts the drain's retries reports the connection down instead of
   *  leaving the frame held. An entry goes when its frame is answered
   *  otherwise; the whole map goes when the adapter starts. */
  private readonly refusedWhileStopped = new Map<string, number>();
  private readonly dedup = new InboundDedup(5_000);
  private readonly userNames = new Map<string, SlackMember>();
  private abort = new AbortController();
  private depositKey: string;
  private readonly readGate: SlackReadGate;
  private readonly repliesGate: SlackReadGate;
  /** The channels the app is a member of, by name. */
  private readonly memberChannels: SlackMemberChannels;
  constructor(private readonly config: SlackAppAdapterConfig) {
    this.depositKey = config.depositKey;
    this.memberChannels = new SlackMemberChannels({ api: config.api, teamId: config.teamId });
    this.readGate =
      config.readGate ??
      new SlackReadGate({ intervalMs: HISTORY_INTERVAL_MS, maxWaitMs: HISTORY_MAX_WAIT_MS });
    this.repliesGate =
      config.repliesGate ??
      config.readGate ??
      new SlackReadGate({ intervalMs: HISTORY_INTERVAL_MS, maxWaitMs: HISTORY_MAX_WAIT_MS });
  }

  onInbound(handler: (message: Message) => void | Promise<void>): void {
    this.handler = handler;
  }

  /** Takes frames from the mailbox's drain from now on. */
  start(): void {
    if (this.abort.signal.aborted) this.abort = new AbortController();
    this.refusedWhileStopped.clear();
    log.info("slack app started", { teamId: this.config.teamId });
  }

  /** The key the Worker gave this instance at its latest connect. */
  setDepositKey(depositKey: string): void {
    this.depositKey = depositKey;
  }

  stop(): void {
    this.abort.abort(new Error("Slack app adapter stopped."));
  }

  /**
   * One drained frame. 200 once Chats has the message on record, now or
   * already, or for an event Rome does not take; 401 for a frame the Worker
   * did not sign for this instance and 400 for one that is no event of this
   * workspace, both dropped for good; 500 when the message was not recorded,
   * so the mailbox delivers it again.
   */
  async handleFrame(frame: MailboxFrame): Promise<{ status: number }> {
    const body = frame.body ?? new Uint8Array(0);
    if (this.abort.signal.aborted || !this.handler) return { status: 500 };
    if (!isDepositedFor({ headers: frame.headers, body, depositKey: this.depositKey })) {
      log.warn("slack app frame dropped: not signed for this Rome");
      return { status: 401 };
    }
    let payload: SlackEventCallback;
    try {
      payload = JSON.parse(new TextDecoder().decode(body)) as SlackEventCallback;
    } catch {
      return { status: 400 };
    }
    if (payload?.type !== "event_callback" || payload.team_id !== this.config.teamId) {
      return { status: 400 };
    }
    if (typeof payload.event_id !== "string") return { status: 200 };
    return this.handleEvent(payload, payload.event_id);
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
    const wire: SlackWireMessage = { ...event, ts: event.ts };
    // Slack sends the app an event for each of its own posts. Those are
    // matched on the bot's own user from the install, not on any bot id, so
    // another bot that mentions the app is still heard. Its own post is never
    // handed over.
    if (event.user === this.config.botUserId) return { status: 200 };
    // A bot or workflow that mentions the app posts as a bot_message, often
    // with no user: the bot is its author. Only a mention is taken from one,
    // since the app's own posts are told apart by their user.
    if (!isSaid(event.subtype)) return { status: 200 };
    const author = event.user ?? (mention ? authorOf(event) : undefined);
    if (!author || typeof event.text !== "string") return { status: 200 };
    const name = event.user ? await this.lookUpName(event.user) : {};
    const said = slackMessage(this.context(event.channel), wire, name);
    if (!said) return { status: 200 };

    const message: ChannelMessage = {
      ...said,
      ...(name.displayName ? { senderDisplayName: name.displayName } : {}),
      ...(name.username ? { senderUsername: name.username } : {}),
      raw: payload,
      // A thread lives inside its conversation's chat. The reply finds the
      // thread from the id of the message it answers.
      ...(event.thread_ts ? { replyTo: { messageId: event.thread_ts } } : {}),
      // A reply in a thread is read with the thread's earlier messages, which
      // the conversation's chat does not hold.
      // In a direct message the app hears every reply, so only a thread in a
      // group is read.
      ...(!direct && event.thread_ts && event.thread_ts !== event.ts
        ? { inThread: `${event.channel}:${event.thread_ts}` as ChatId }
        : {}),
    };
    // The mailbox is told the message was received only once Chats has it on
    // record (docs/domains/connections.md#message). A delivery that is
    // refused or not recorded in time answers 500, and the mailbox delivers it
    // again; Chats records a message it already holds only once. The drain
    // drops a frame after its retries, so the refusal also reports the
    // connection down and the runtime starts it again after a backoff.
    // Recording stopping is no fault while the drain's own retries remain: an
    // app swapping its hook stops it for a moment. A stop that outlasts them is.
    if (!this.handler) return { status: 500 };
    try {
      await this.handler(
        messageOf(message, slackSenderId(this.config.teamId, this.config.botUserId)),
      );
    } catch (error) {
      if (error instanceof RecordingStopped) {
        const refused = (this.refusedWhileStopped.get(eventId) ?? 0) + 1;
        if (refused < this.config.deliveryAttempts) {
          this.refusedWhileStopped.set(eventId, refused);
          log.info("slack app message not recorded yet: recording stopped");
          return { status: 500 };
        }
        this.refusedWhileStopped.delete(eventId);
        log.warn("slack app message refused past the drain's retries: recording stopped");
        this.config.onFault?.({ kind: "transport", cause: error });
        return { status: 500 };
      }
      this.refusedWhileStopped.delete(eventId);
      log.error("slack app message not accepted", { error: describe(error) });
      this.config.onFault?.({ kind: "transport", cause: error });
      return { status: 500 };
    }
    this.refusedWhileStopped.delete(eventId);
    log.info("message received", { chatId: message.chatId });
    return { status: 200 };
  }

  /**
   * An event that is not a message: the app removed or its token revoked. The
   * Worker lets go of the workspace before it deposits such an event, unless
   * the event is older than the install. So the connection ends only when the
   * Worker no longer holds the workspace for this instance: a removal that
   * waited in the mailbox while the guardian connected again ends nothing. A
   * check that cannot reach the Worker reports the connection down, and the
   * restart checks again.
   */
  private async handleSignal(payload: SlackEventCallback): Promise<void> {
    const event = payload.event;
    const removed =
      event.type === "app_uninstalled" ||
      (event.type === "tokens_revoked" && !!event.tokens?.bot?.includes(this.config.botUserId));
    if (!removed) return;
    const signal = this.abort.signal;
    try {
      if (await this.config.bound()) {
        log.info("slack app's workspace outlived a removal event", { event: event.type });
        return;
      }
      if (signal.aborted) return;
      this.config.onFault?.({
        kind: "credential",
        cause: new SlackApiError(
          "app_uninstalled",
          "Rome's Slack app was removed from the workspace.",
        ),
      });
    } catch (error) {
      if (signal.aborted) return;
      this.config.onFault?.({ kind: "transport", cause: error });
    }
  }

  async send(named: ChatId, message: OutgoingMessage): Promise<MessageReceipt> {
    refuseAttachments("slack", message);
    // Only a channel's name waits on Slack, so a send by id posts at once.
    const chatId = named.startsWith("#")
      ? await this.memberChannels.resolve(named, this.abort.signal, { fresh: true })
      : named;
    const text = textToSend("slack", message).trim();
    const replyTo = replyToShaped("slack", message.replyToMessageId, SLACK_MESSAGE_ID);
    const parsed = parseSlackChatId(chatId);
    const threadTs = parsed.threadTs ?? replyThreadOf(parsed.channelId, replyTo);
    let firstTs: string | undefined;
    for (const chunk of splitSlackText(text)) {
      const sent = await this.config.api.postMessage(
        this.config.teamId,
        { channel: parsed.channelId, markdown: chunk, threadTs },
        this.abort.signal,
      );
      firstTs ??= sent.ts;
    }
    return { chatId, ...(firstTs ? { messageId: slackMessageId(firstTs, threadTs) } : {}) };
  }

  /** Reacts to message `messageId` in `chatId` with `emoji`, as the app's
   *  bot. Slack names its emoji, so only those Rome reacts with are known. */
  async react(chatId: ChatId, messageId: string, emoji: string): Promise<void> {
    await this.config.api.addReaction(
      this.config.teamId,
      this.reactionOf(chatId, messageId, emoji),
      this.abort.signal,
    );
  }

  /** Takes the bot's own reaction `emoji` off message `messageId` in `chatId`. */
  async unreact(chatId: ChatId, messageId: string, emoji: string): Promise<void> {
    await this.config.api.removeReaction(
      this.config.teamId,
      this.reactionOf(chatId, messageId, emoji),
      this.abort.signal,
    );
  }

  // Slack names its emoji, so only those Rome reacts with are known.
  private reactionOf(chatId: ChatId, messageId: string, emoji: string) {
    const name = SLACK_EMOJI_NAMES[emoji];
    if (!name) throw new Error(`Slack has no emoji name Rome knows for ${emoji}`);
    const timestamp = messageId.slice(messageId.lastIndexOf(":") + 1);
    if (!/^\d+\.\d+$/.test(timestamp)) {
      throw new Error(`Slack cannot react to message "${messageId}": it is not a Slack message id`);
    }
    return { channel: parseSlackChatId(chatId).channelId, timestamp, name };
  }

  private context(chatId: string) {
    return {
      channel: this.config.channel,
      teamId: this.config.teamId,
      botUserId: this.config.botUserId,
      chatId,
    };
  }

  /** One page of a chat's history, taking its turn at the read gate. History
   *  and a thread's replies each name their own kind of call, so a page
   *  ending at a thread's root never takes the thread's answer. */
  private historyPage: FetchHistoryPage = (channelId, bounds) =>
    this.readGate.run(
      `history:${channelId}:${bounds.latest ?? ""}`,
      () => this.fetchPage(channelId, bounds.latest),
      this.abort.signal,
    );

  private async fetchPage(channelId: string, latest: string | undefined) {
    const page = await this.config.api.conversationHistory(
      this.config.teamId,
      { channel: channelId, ...(latest ? { latest } : {}), limit: HISTORY_PAGE },
      this.abort.signal,
    );
    const wires = page.messages.filter(inTimeline);
    const names = await this.namesOf(
      wires.flatMap((wire) =>
        wire.user && wire.user !== this.config.botUserId ? [wire.user] : [],
      ),
    );
    const messages: Array<{ ts: string; message: ChannelMessage }> = [];
    for (const wire of wires) {
      const name = (wire.user && names.get(wire.user)) || {};
      const message = slackMessage(this.context(channelId), wire, name);
      if (message) {
        messages.push({
          ts: wire.ts,
          message,
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
    const resolved = chatId.startsWith("#")
      ? await this.memberChannels.resolve(chatId, this.abort.signal)
      : chatId;
    const { channelId, threadTs } = parseSlackChatId(resolved);
    try {
      if (threadTs) return await this.readThread(channelId, threadTs, read);
      return await readTimeline(this.historyPage, channelId as ChatId, read);
    } catch (error) {
      throw unreadable(error, chatId);
    }
  }

  /**
   * A thread's messages within `read`'s bounds, newest first, its root
   * included. Slack answers a thread oldest first, one page of 15 a minute,
   * so one read is one page: a read below a bound (`olderThan`, `until`)
   * answers the newest of the thread's first page, and any other read answers
   * the oldest `limit` from the thread's start or just after `newerThan`. A
   * longer thread is read on with `newerThan`, each page asking Slack from
   * there, until a read comes back empty.
   */
  private async readThread(
    channelId: string,
    threadTs: string,
    read: TalkHistoryRead,
  ): Promise<ChannelMessage[]> {
    const oldest = read.newerThan;
    const page = await this.repliesGate.run(
      `replies:${channelId}:${threadTs}:${oldest ?? ""}`,
      () =>
        this.config.api.conversationReplies(
          this.config.teamId,
          {
            channel: channelId,
            ts: threadTs,
            limit: HISTORY_PAGE,
            ...(oldest ? { oldest } : {}),
          },
          this.abort.signal,
        ),
      this.abort.signal,
    );
    const wires = page.messages.filter((wire) => isSaid(wire.subtype));
    const names = await this.namesOf(
      wires.flatMap((wire) =>
        wire.user && wire.user !== this.config.botUserId ? [wire.user] : [],
      ),
    );
    const messages: ChannelMessage[] = [];
    for (const wire of wires) {
      if (!withinRead(wire.ts, read)) continue;
      const name = (wire.user && names.get(wire.user)) || {};
      const message = slackMessage(this.context(channelId), wire, name);
      if (message) messages.push(message);
    }
    // A page Slack goes on from that held nothing Rome reads, such as only
    // file shares with no text, must not read as the thread's end.
    const lastRaw = page.messages.at(-1)?.ts;
    if (messages.length === 0 && page.nextCursor && lastRaw) {
      throw new Error(
        `Slack's page of thread ${channelId}:${threadTs} held only messages Rome does not read, such as files with no text, and the thread goes on. Read on with newerThan=${lastRaw}, which conversations.replies takes as its cursor.`,
      );
    }
    messages.sort((a, b) => compareTs(tsOfId(b.messageId), tsOfId(a.messageId)));
    // A read on from a message answers the messages just after it, whatever
    // bounds it above.
    const below =
      read.newerThan === undefined && (read.olderThan !== undefined || read.until !== undefined);
    return below
      ? messages.slice(0, read.limit)
      : messages.slice(Math.max(0, messages.length - read.limit));
  }

  /** The channels the app is a member of, by name. */
  async channels(): Promise<SlackChannel[]> {
    return this.memberChannels.list(this.abort.signal);
  }

  /** The direct-message conversation with a member of this workspace. */
  async directConversationFor(senderId: string): Promise<ChatId | null> {
    const separator = senderId.indexOf("/");
    if (separator === -1 || senderId.slice(0, separator) !== this.config.teamId) return null;
    const userId = slackUserIdOf(senderId.trim());
    if (!userId) return null;
    return (await this.config.api.openDirectMessage(
      this.config.teamId,
      userId,
      this.abort.signal,
    )) as ChatId;
  }

  /** The names of `authors`, each looked up once and all together. A page is
   *  answered without the names Slack has not given within
   *  {@link NAME_WAIT_MS}, so a slow lookup never holds up a read. */
  private async namesOf(authors: readonly string[]): Promise<Map<string, SlackMember>> {
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

  /** A member's name, best effort: a failed lookup leaves the message unnamed. */
  private async lookUpName(userId: string): Promise<SlackMember> {
    const cached = this.userNames.get(userId);
    if (cached) return cached;
    try {
      const name = await this.config.api.userName(this.config.teamId, userId, this.abort.signal);
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
