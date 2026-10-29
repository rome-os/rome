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
   * Put `message` on record in its place, and raise MessageRecorded once it
   * is committed. Answers the recorded message, or null when the platform's
   * id for it is already on record in that place: recording again changes
   * nothing and raises nothing.
   *
   * The place's chat must already exist: a message never starts its chat.
   * Throws when it does not.
   */
  record(message: Message, via: Via): Promise<RecordedMessage | null>;

  /**
   * The newest `limit` messages said in `place`, oldest first. A message
   * still pending, or one the platform refused, was not said and is not here.
   * A place Rome holds no messages in answers an empty page.
   */
  recent(place: Place, limit: number): Promise<MessagePage>;

  /** The `limit` messages said in `place` just before `cursor`, oldest
   *  first, by the same rule as {@link recent}. */
  before(place: Place, cursor: MessageCursor, limit: number): Promise<MessagePage>;
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
  "findChannelChat" | "addConversationMessage" | "saidMessagesAt"
>;

export class StoredMessages implements MessageRepository {
  constructor(
    private readonly rows: MessageRows,
    private readonly events: ChatEvents,
    private readonly history: MessageHistory,
  ) {}

  recent(place: Place, limit: number): Promise<MessagePage> {
    return this.page(place, limit);
  }

  before(place: Place, cursor: MessageCursor, limit: number): Promise<MessagePage> {
    return this.page(place, limit, cursor);
  }

  private async page(place: Place, limit: number, before?: MessageCursor): Promise<MessagePage> {
    // One more than asked says whether any are older.
    const rows = await this.rows.saidMessagesAt({
      channels: this.history.channelsOn(place.chat.platform),
      address: addressOf(place),
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
    const { inserted } = await this.rows.addConversationMessage({
      sessionId: chat.id,
      // Recorded before any agent is woken by it, so it reads as something
      // said while the agent was away. A wake makes it the turn's prompt.
      role: "notification",
      content: JSON.stringify([{ type: "text", content: plainText(message.body) }]),
      platformMessageId: message.platformMessageId,
      // The account's platform is the place's, so the row keeps only its id.
      senderId: saidBy.account.id,
      ...(saidBy.name === undefined ? {} : { senderName: saidBy.name }),
      ...(saidBy.onBehalfOf === undefined ? {} : { onBehalfOf: saidBy.onBehalfOf }),
      ...(message.replyTo === undefined ? {} : { replyToPlatformMessageId: message.replyTo }),
      createdAt: message.at,
    });
    if (!inserted) return null;
    const recorded: RecordedMessage = {
      ...message,
      id: conversationPlatformMessageId(chat.id, message.platformMessageId),
    };
    await this.events.publish({
      type: "MessageRecorded",
      message: recorded,
      chatRecordId: chat.id,
      via,
    });
    return recorded;
  }
}

/** Rome's line, said as the channel's own account. A delegate's reply says
 *  which agent it was on behalf of. */
function romeSaidBy(account: Account | null, row: StoredSaidMessage): SaidBy | undefined {
  if (!account) return undefined;
  return {
    account,
    ...(row.senderName === null ? {} : { name: row.senderName }),
    ...(row.onBehalfOf === null ? {} : { onBehalfOf: row.onBehalfOf }),
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
