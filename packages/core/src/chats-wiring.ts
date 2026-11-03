// Chats, the adapters that feed it, and Agents' speakers, turn links and
// replies over one database, built once so startup, the action worker and
// tests hold the same objects wired the same way. Vocabulary:
// docs/domains/chats.md and docs/domains/participation.md.
//
// Nothing live uses it yet: the Chats switch moves startup onto it.

import type { Account, Channel, ChatId } from "@rome-os/app-runtime";
import { ChatRepository } from "./chats/storage/chat-repository.js";
import { MessageRepository } from "./chats/storage/message-repository.js";
import type { ChatRef } from "./chats/storage/place.js";
import { ChatAdapters } from "./connections/chat-adapter.js";
import { ChatAddresses } from "./connections/chat-addresses.js";
import { chatKey, type ChatKey } from "./connections/chat-ids.js";
import { EMAIL_PLATFORM, emailChatAdapter } from "./connections/email-chat-adapter.js";
import { recordedSends } from "./connections/recorded-sends.js";
import { SpeakerLines } from "./connections/speaker-lines.js";
import type { DrizzleDb } from "./db/index.js";
import { SpeakerReplies } from "./sessions/speaker-replies.js";
import { Speakers } from "./sessions/speakers.js";
import { TurnLinks } from "./sessions/turn-links.js";
import { ChatReadModel } from "./webchat/chat-read-model.js";

export interface ChatsWiringDeps {
  /** Rome's account on a channel, or null while its record knows none. */
  accountOf(channel: string): Account | null;
  platformOfChannel(channel: string): string;
  /** The channels of Rome's accounts on `platform`. */
  channelsOn(platform: string): readonly string[];
}

export type ChatsWiring = ReturnType<typeof chatsWiring>;

export function chatsWiring(db: DrizzleDb, deps: ChatsWiringDeps) {
  const chats = new ChatRepository(db);
  const messages = new MessageRepository(db);
  const addresses = new ChatAddresses(db);
  const adapters = new ChatAdapters({
    accountOf: deps.accountOf,
    platformOfChannel: deps.platformOfChannel,
    channelsOn: deps.channelsOn,
    addresses,
    platforms: { [EMAIL_PLATFORM]: emailChatAdapter },
    keyOf(ref: ChatRef): ChatKey {
      const chat = chats.get(ref);
      if (!chat) throw new Error(`No chat ${ref.platform}:${ref.id}`);
      return chatKey(ref.platform, chat.key as ChatId);
    },
  });
  const speakers = new Speakers(db, chats);
  const links = new TurnLinks(db, messages);
  const replies = new SpeakerReplies({ speakers, adapters, messages, links });
  const speakerLines = new SpeakerLines({ speakers, messages, adapters });
  const reads = new ChatReadModel(db, { messages, links });
  return {
    chats,
    messages,
    addresses,
    adapters,
    speakers,
    links,
    replies,
    speakerLines,
    reads,
    /** `channels` with each send recorded through Chats. */
    recordedSends<C extends Channel>(channels: readonly C[]): C[] {
      return recordedSends(channels, { adapters, chats, speakers, replies, messages });
    },
  };
}
