// Messages on record. Vocabulary: docs/domains/chats.md#message.
//
// Over today's storage a message is a `rome_agent_messages` row in its chat's
// `rome_sessions` row, which a channel and the platform's address for the
// place key. Callers see places and accounts, never rows, so the storage can
// move under this interface.

import {
  conversationPlatformMessageId,
  type WebChatRepository,
} from "../db/repositories/webchat.js";
import type { ChatEvents, Via } from "./events.js";
import { plainText, type Message, type RecordedMessage } from "./message.js";
import { addressOf } from "./place.js";

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
   * Note that Participation has decided whether the recorded message `id`
   * wakes an agent. Until then a turn does not catch up on it, since it may
   * yet become a turn's prompt of its own.
   */
  wakeDecided(id: string): Promise<void>;

  /** Whether the wake for the recorded message `id` is still undecided. */
  isWakeUndecided(id: string): boolean;
}

type MessageRows = Pick<WebChatRepository, "findChannelChat" | "addConversationMessage">;

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
  ) {}

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
      type: "MessageRecorded",
      message: recorded,
      chatRecordId: chat.id,
      via,
    });
    return recorded;
  }

  async wakeDecided(id: string): Promise<void> {
    this.undecided.delete(id);
  }

  isWakeUndecided(id: string): boolean {
    return this.undecided.has(id);
  }
}
