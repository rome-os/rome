// Chats, the adapters that feed it, and Agents' seat links and replies over
// one database. Startup, the action worker and tests build them here, so all
// three hold the same objects wired the same way. Vocabulary:
// docs/domains/chats.md.

import type { Account } from "@rome-os/app-runtime";
import { ChatAdapters } from "./chats/adapter.js";
import { ChatRepository } from "./chats/chat-repository.js";
import { ChatEvents } from "./chats/events.js";
import { MessageRepository } from "./chats/message-repository.js";
import { ChatAddresses } from "./channels/chat-addresses.js";
import { EMAIL_PLATFORM, emailChatAdapter } from "./channels/email-chat-adapter.js";
import { SeatLines } from "./channels/seat-lines.js";
import type { DrizzleDb } from "./db/index.js";
import type { WebChatRepository } from "./db/repositories/webchat.js";
import { SeatReplies } from "./sessions/seat-replies.js";
import { TurnLinks } from "./sessions/turn-links.js";
import { ChatReadModel } from "./webchat/chat-read-model.js";

export interface ChatWiringDeps {
  /** Rome's account on a channel, or null while its record knows none. */
  accountOf(channel: string): Account | null;
  platformOfChannel(channel: string): string;
  /** The channels of Rome's accounts on `platform`. */
  channelsOn(platform: string): readonly string[];
  /** Where each session stands. */
  seats: Pick<WebChatRepository, "seatOf">;
}

export function chatWiring(db: DrizzleDb, deps: ChatWiringDeps) {
  const chats = new ChatRepository(db);
  const events = new ChatEvents();
  const messages = new MessageRepository(db);
  const links = new TurnLinks(db);
  const adapters = new ChatAdapters({
    accountOf: deps.accountOf,
    platformOfChannel: deps.platformOfChannel,
    channelsOn: deps.channelsOn,
    addresses: new ChatAddresses(db),
    platforms: { [EMAIL_PLATFORM]: emailChatAdapter },
  });
  const replies = new SeatReplies({ seats: deps.seats, adapters, messages, links });
  const reads = new ChatReadModel(db, { messages, links });
  // The SDK's message ids, as the lines Rome holds where a seat stands.
  const seatLines = new SeatLines({ seats: deps.seats, messages });
  return { chats, events, messages, links, adapters, replies, reads, seatLines };
}

export type ChatWiring = ReturnType<typeof chatWiring>;
