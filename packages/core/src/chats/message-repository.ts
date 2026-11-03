// Messages on record. Vocabulary: docs/domains/chats.md#message.
//
// Over today's storage a message is a `rome_agent_messages` row in its chat's
// `rome_sessions` row, which a channel and the platform's address for the
// place key. Callers see places and accounts, never rows, so the storage can
// move under this interface.

import type { Account } from "@rome-os/app-runtime";
import { isAgentMessageOutbound, messageContentText } from "../channels/messages-agent.js";
import {
  conversationPlatformMessageId,
  type StoredSaidMessage,
  type WebChatRepository,
} from "../db/repositories/webchat.js";
import type { ChatEvents, Via } from "./events.js";
import {
  plainText,
  type Message,
  type OutboundMessage,
  type RecordedMessage,
  type SaidBy,
  type SaidMessage,
} from "./message.js";
import { addressOf, type Place } from "./place.js";

/** A position in a place's messages, oldest to newest. Opaque to callers,
 *  which hand back the one a page answered. */
export interface MessageCursor {
  readonly at: Date;
  readonly id: string;
}

/**
 * Some of a place's messages, oldest first. `older` is where the messages
 * before these begin, for {@link MessageRepository.before}, and null when
 * none are older.
 */
export interface MessagePage {
  readonly messages: readonly SaidMessage[];
  readonly older: MessageCursor | null;
}

export interface MessageRepository {
  /**
   * Put `message` on record in its place, and raise MessageSaid once it
   * is committed. Answers the recorded message, or null when the platform's
   * id for it is already on record in that place: recording again changes
   * nothing and raises nothing.
   *
   * The place's chat must already exist: a message never starts its chat.
   * Throws when it does not.
   */
  record(message: Message, via: Via): Promise<RecordedMessage | null>;

  /**
   * Put a message Rome said through the channel `via` names on record in its
   * place. A message whose platform id is already on record there updates
   * that record, and one its turn already holds as the answer joins it, so
   * recording a reply again leaves one message. Raises nothing: nothing
   * listens for Rome's own messages yet.
   *
   * The place's chat must already exist, as for {@link record}.
   */
  recordSent(message: OutboundMessage, via: Pick<Via, "channel">): Promise<void>;

  /**
   * The newest `limit` messages on record in `place`, oldest first. A place
   * Rome holds no messages in answers an empty page. Today's storage keeps no
   * delivery, so an agent's reply whose send is pending or was refused is
   * read too (see {@link SaidMessage}).
   *
   * `via` is the one of Rome's accounts reading, over today's storage, and
   * the place reads as that account heard it. Absent, a group reads as one
   * chat across every account in it, and a direct message reads only while
   * one account holds it, since its address alone may name a direct message
   * with each of Rome's accounts.
   */
  recent(place: Place, limit: number, via?: Pick<Via, "channel">): Promise<MessagePage>;

  /** The `limit` messages said in `place` just before `cursor`, oldest
   *  first, by the same rule as {@link recent}. */
  before(
    place: Place,
    cursor: MessageCursor,
    limit: number,
    via?: Pick<Via, "channel">,
  ): Promise<MessagePage>;

  /**
   * The messages `ids` name in `place`, oldest first, read by the same rule
   * as {@link recent}. An id may name any copy of a message, and the message
   * is read once under its first copy's id. An id the place does not hold is
   * left out.
   */
  find(place: Place, ids: readonly string[], via?: Pick<Via, "channel">): Promise<SaidMessage[]>;

  /**
   * Note that Participation has decided whether the recorded message `id`
   * wakes an agent. Until then a turn does not catch up on it, since it may
   * yet become a turn's prompt of its own.
   */
  wakeDecided(id: string): Promise<void>;

  /** Whether the wake for the recorded message `id` is still undecided. */
  isWakeUndecided(id: string): boolean;
}

/**
 * Where reads find a platform's messages over today's storage. `channelsOn`
 * names every channel a platform's chats are kept under, so a group two of
 * Rome's accounts are in reads as one chat although each account keeps a row
 * for it. `accountOf` is Rome's own account on a channel, which said Rome's
 * lines there.
 */
export interface MessageHistory {
  channelsOn(platform: string): readonly string[];
  accountOf?(channel: string): Account | null;
}

type MessageRows = Pick<
  WebChatRepository,
  | "findChannelChat"
  | "addConversationMessage"
  | "recordOutboundConversationMessage"
  | "saidMessagesAt"
>;

export class StoredMessages implements MessageRepository {
  /**
   * The messages whose wake is undecided. Kept in memory, not on the row, so
   * today's schema carries it unchanged. A restart forgets it, which decides
   * every wake in flight: the decision died with the process.
   */
  private readonly undecided = new Set<string>();

  constructor(
    private readonly rows: MessageRows,
    private readonly events: ChatEvents,
    private readonly history: MessageHistory,
  ) {}

  recent(place: Place, limit: number, via?: Pick<Via, "channel">): Promise<MessagePage> {
    return this.page(place, limit, via);
  }

  before(
    place: Place,
    cursor: MessageCursor,
    limit: number,
    via?: Pick<Via, "channel">,
  ): Promise<MessagePage> {
    return this.page(place, limit, via, cursor);
  }

  async find(
    place: Place,
    ids: readonly string[],
    via?: Pick<Via, "channel">,
  ): Promise<SaidMessage[]> {
    if (ids.length === 0) return [];
    const rows = await this.rows.saidMessagesAt({
      channels: this.history.channelsOn(place.chat.platform),
      address: addressOf(place),
      ...(via ? { ownChannel: via.channel } : {}),
      localIds: numbersPerAccount(place),
      ids,
      limit: ids.length,
    });
    return rows.reverse().map((row) => this.said(place, row));
  }

  private async page(
    place: Place,
    limit: number,
    via?: Pick<Via, "channel">,
    before?: MessageCursor,
  ): Promise<MessagePage> {
    // One more than asked says whether any are older.
    const rows = await this.rows.saidMessagesAt({
      channels: this.history.channelsOn(place.chat.platform),
      address: addressOf(place),
      ...(via ? { ownChannel: via.channel } : {}),
      localIds: numbersPerAccount(place),
      ...(before ? { before } : {}),
      limit: limit + 1,
    });
    const shown = rows.slice(0, limit);
    const oldest = shown.at(-1);
    return {
      messages: shown.reverse().map((row) => this.said(place, row)),
      older: rows.length > limit && oldest ? { at: oldest.createdAt, id: oldest.id } : null,
    };
  }

  private said(place: Place, row: StoredSaidMessage): SaidMessage {
    const fromRome = isAgentMessageOutbound(row.role, row.senderId);
    const saidBy = fromRome
      ? romeSaidBy(this.history.accountOf?.(row.channel) ?? null, row)
      : personSaidBy(place, row);
    return {
      id: row.id,
      direction: fromRome ? "fromRome" : "toRome",
      place,
      ...(saidBy ? { saidBy } : {}),
      ...(row.senderName === null ? {} : { senderName: row.senderName }),
      body: { text: messageContentText(row.content) ?? "" },
      ...(row.platformMessageId === null ? {} : { platformMessageId: row.platformMessageId }),
      ...(row.replyToPlatformMessageId === null ? {} : { replyTo: row.replyToPlatformMessageId }),
      at: row.createdAt,
      ...(row.turnId === null ? {} : { turnId: row.turnId }),
    };
  }

  async record(message: Message, via: Via): Promise<RecordedMessage | null> {
    const address = addressOf(message.place);
    const chat = await this.rows.findChannelChat(via.channel, address);
    if (!chat) {
      throw new Error(`No chat at ${via.channel}:${address} to record a message in`);
    }
    const { saidBy } = message;
    if (saidBy.onBehalfOf !== undefined) {
      throw new Error("A message said on another's behalf cannot be recorded yet");
    }
    const id = conversationPlatformMessageId(chat.id, message.platformMessageId);
    // Undecided before the row is written, so no catch-up read sees it in
    // between. A redelivery of a message still undecided leaves it so.
    const alreadyUndecided = this.undecided.has(id);
    this.undecided.add(id);
    const { inserted } = await this.rows
      .addConversationMessage({
        sessionId: chat.id,
        // Recorded before any agent is woken by it, so it reads as something
        // said while the agent was away. A wake makes it the turn's prompt.
        role: "notification",
        content: JSON.stringify([{ type: "text", content: plainText(message.body) }]),
        platformMessageId: message.platformMessageId,
        // The account's platform is the place's, so the row keeps only its id.
        senderId: saidBy.account.id,
        ...(saidBy.name === undefined ? {} : { senderName: saidBy.name }),
        ...(message.replyTo === undefined ? {} : { replyToPlatformMessageId: message.replyTo }),
        createdAt: message.at,
      })
      .catch((error: unknown) => {
        if (!alreadyUndecided) this.undecided.delete(id);
        throw error;
      });
    if (!inserted) {
      if (!alreadyUndecided) this.undecided.delete(id);
      return null;
    }
    const recorded: RecordedMessage = { ...message, id };
    await this.events.publish({
      type: "MessageSaid",
      message: recorded,
      chatRecordId: chat.id,
      via,
    });
    return recorded;
  }

  async recordSent(message: OutboundMessage, via: Pick<Via, "channel">): Promise<void> {
    const address = addressOf(message.place);
    const chat = await this.rows.findChannelChat(via.channel, address);
    if (!chat) {
      throw new Error(`No chat at ${via.channel}:${address} to record a message in`);
    }
    await this.rows.recordOutboundConversationMessage({
      sessionId: chat.id,
      content: JSON.stringify(message.parts),
      ...(message.platformMessageId === undefined
        ? {}
        : { platformMessageId: message.platformMessageId }),
      ...(message.otherPlatformMessageIds === undefined
        ? {}
        : { otherPlatformMessageIds: [...message.otherPlatformMessageIds] }),
      ...ROME_SENDER,
      ...(message.replyTo === undefined ? {} : { replyToPlatformMessageId: message.replyTo }),
      ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
      knownToProvider: message.turnAnswer,
    });
  }

  async wakeDecided(id: string): Promise<void> {
    this.undecided.delete(id);
  }

  isWakeUndecided(id: string): boolean {
    return this.undecided.has(id);
  }
}

/** The sender a row of Rome's own keeps. `isAgentMessageOutbound` reads it
 *  back to put the line on Rome's side of the chat. */
const ROME_SENDER = { senderId: "rome", senderName: "Rome" } as const;

/** Rome's line, said as the channel's own account. */
function romeSaidBy(account: Account | null, row: StoredSaidMessage): SaidBy | undefined {
  if (!account) return undefined;
  return {
    account,
    ...(row.senderName === null ? {} : { name: row.senderName }),
  };
}

/** A message to Rome, said by the account the row keeps the platform's id
 *  of. The account is on the place's platform, as every participant is. */
function personSaidBy(place: Place, row: StoredSaidMessage): SaidBy | undefined {
  if (row.senderId === null) return undefined;
  return {
    account: { platform: place.chat.platform, id: row.senderId },
    ...(row.senderName === null ? {} : { name: row.senderName }),
  };
}

/**
 * Whether each of Rome's accounts numbers this place's messages itself. A
 * Telegram basic group gives every member account its own message ids, so
 * the same id on two accounts names two messages. Telegram addresses a basic
 * group as `-<id>` below 10^12 and a supergroup or channel as
 * `-(10^12 + <id>)`, so the range tells them apart
 * (https://core.telegram.org/api/bots/ids).
 */
function numbersPerAccount(place: Place): boolean {
  const { platform, id } = place.chat;
  if (platform !== "telegram" || !/^-[1-9]\d*$/.test(id)) return false;
  return BigInt(id.slice(1)) < 1_000_000_000_000n;
}
