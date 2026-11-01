// The chat adapter conformance suite: what every adapter owes Chats, checked
// against a platform's peer through Rome's production paths. A case reads
// only what a person sees on the peer and what Rome's transcript holds, never
// an adapter's internals. Contract: docs/architecture/channels.md#chat-adapters.

import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type {
  Account,
  Channel,
  ChannelMessage,
  ChatId,
  MessageReceipt,
  OutgoingMessage,
} from "@rome-os/app-runtime";
import type { ChannelSend } from "../../../channels/channel.js";
import { ChatAddresses } from "../../../channels/chat-addresses.js";
import { recordedSends } from "../../../channels/recorded-sends.js";
import { ChatAdapters } from "../../../chats/adapter.js";
import { ChatRepository } from "../../../chats/chat-repository.js";
import { ChatEvents, type MessageSaid } from "../../../chats/events.js";
import { inboundRecording } from "../../../chats/inbound.js";
import { MessageRepository } from "../../../chats/message-repository.js";
import { placeIn } from "../../../chats/place.js";
import { WebChatRepository } from "../../../db/repositories/webchat.js";
import { SeatReplies } from "../../../sessions/seat-replies.js";
import { TurnLinks } from "../../../sessions/turn-links.js";
import { createTestDb, type TestDb } from "../../helpers.js";
import { deferred, type VisibleMessage } from "./peer.js";

/** A production adapter running against its platform's peer, with a person
 *  Rome's account can reach directly. */
export interface ConformanceChannel {
  /** Rome's account on the platform, as its channel record names it. */
  readonly account: Account;
  /** The adapter as a channel, which Chats' adapter is built over. */
  readonly channel: Channel;
  /** The person's own address, where Rome opens a direct message to them. */
  readonly person: string;
  /** Where the platform shows that direct message. */
  readonly dm: string;
  /** The person writes to Rome's account directly. */
  personWrites(text: string): void;
  /** What a person in conversation `at` sees there. */
  visible(at: string): VisibleMessage[];
  stop(): Promise<void>;
}

/** A legacy channel adapter as the `Channel` ports Chats' adapter takes. */
export function channelOver(
  name: string,
  connectionId: string,
  adapter: {
    send(chatId: ChatId, message: OutgoingMessage): Promise<MessageReceipt>;
    onInbound(handler: (message: ChannelMessage) => Promise<void>): void;
  },
): Channel {
  const handlers = new Set<
    (
      event: Parameters<Parameters<NonNullable<Channel["inbound"]>["subscribe"]>[0]>[0],
    ) => Promise<void>
  >();
  adapter.onInbound(async (message) => {
    for (const handler of handlers)
      await handler({ kind: "message", message, ref: { connectionId, chatId: message.chatId } });
  });
  return {
    name,
    send: {
      send: (address: ChatId, message: OutgoingMessage) => adapter.send(address, message),
    } as unknown as ChannelSend,
    inbound: {
      subscribe(handler) {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      media: null,
    },
  };
}

/**
 * Runs the conformance cases for the adapter `start` sets up. Each case gets
 * a fresh database, Rome's inbound recording and its hook send port over the
 * adapter, so what it checks is what Rome itself would do.
 */
export function describeAdapterConformance(
  name: string,
  start: () => Promise<ConformanceChannel>,
): void {
  describe(`chat adapter conformance: ${name}`, () => {
    let testDb: TestDb;
    let peer: ConformanceChannel;
    let chats: ChatRepository;
    let messages: MessageRepository;
    let adapters: ChatAdapters;
    let said: MessageSaid[];
    let stopRecording: () => void;
    let send: ChannelSend;

    beforeEach(async () => {
      testDb = createTestDb();
      peer = await start();
      chats = new ChatRepository(testDb.db);
      messages = new MessageRepository(testDb.db);
      const events = new ChatEvents();
      said = [];
      events.subscribe(async (event) => {
        if (event.type === "MessageSaid") said.push(event);
      });
      adapters = new ChatAdapters({
        accountOf: (channel) => (channel === peer.channel.name ? peer.account : null),
        platformOfChannel: () => peer.account.platform,
        addresses: new ChatAddresses(testDb.db),
        channelsOn: (platform) => (platform === peer.account.platform ? [peer.channel.name] : []),
      });
      stopRecording = inboundRecording({ chats, messages, events, adapters }, [
        peer.channel,
      ]).listen();
      const webchatRepo = new WebChatRepository(testDb.db);
      const [sending] = recordedSends([peer.channel], {
        adapters,
        chats,
        webchatRepo,
        replies: new SeatReplies({
          seats: webchatRepo,
          adapters,
          messages,
          links: new TurnLinks(testDb.db),
        }),
        messages,
      });
      send = sending!.send as ChannelSend;
    });

    afterEach(async () => {
      stopRecording();
      await peer.stop();
      testDb.close();
    });

    /** The person writes `text`; resolves once Rome has it on record. */
    async function personSays(text: string): Promise<MessageSaid> {
      const before = said.length;
      peer.personWrites(text);
      const deadline = Date.now() + 3_000;
      while (said.length === before) {
        if (Date.now() > deadline) throw new Error(`Rome recorded nothing of "${text}"`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return said[before]!;
    }

    /** What Rome's transcript of the chat holds, oldest first. */
    const transcript = (chatId: string) =>
      messages
        .read(placeIn({ platform: peer.account.platform, id: chatId }), { limit: 50 })
        .messages.map((message) => ({
          text: message.body.text,
          fromRome: message.saidBy?.agent !== undefined,
        }));

    /** The platform's direct messages Rome holds, by kind. */
    const directMessages = () =>
      chats.list(peer.account.platform).filter((chat) => chat.kind === "dm");

    it("records a direct message once, in one chat, as the person's", async () => {
      const heard = await personSays("hello Rome");

      expect(transcript(heard.message.place.chat.id)).toEqual([
        { text: "hello Rome", fromRome: false },
      ]);
      expect(directMessages()).toHaveLength(1);
    });

    it("sends a reply to a direct message where the person sees it, and records it there", async () => {
      const heard = await personSays("hello Rome");

      // Rome answers at the person's address, as a hook or an agent names it.
      await send.send(peer.person as ChatId, { text: "hello back" });

      expect(peer.visible(peer.dm).map((m) => [m.from, m.text])).toEqual([
        ["user", "hello Rome"],
        ["rome", "hello back"],
      ]);
      expect(transcript(heard.message.place.chat.id)).toEqual([
        { text: "hello Rome", fromRome: false },
        { text: "hello back", fromRome: true },
      ]);
      expect(directMessages()).toHaveLength(1);
    });

    it("sends a reply to the address the direct message was heard at", async () => {
      const heard = await personSays("hello Rome");

      // The place a reply goes to is the one Rome heard the chat at.
      await send.send(peer.dm as ChatId, { text: "hello again" });

      expect(peer.visible(peer.dm).at(-1)).toMatchObject({ from: "rome", text: "hello again" });
      expect(transcript(heard.message.place.chat.id).at(-1)).toEqual({
        text: "hello again",
        fromRome: true,
      });
      expect(directMessages()).toHaveLength(1);
    });

    it("keeps a direct message Rome opened as the chat the person answers in", async () => {
      await send.send(peer.person as ChatId, { text: "Rome writes first" });
      const answered = await personSays("and the person answers");

      expect(peer.visible(peer.dm).map((m) => [m.from, m.text])).toEqual([
        ["rome", "Rome writes first"],
        ["user", "and the person answers"],
      ]);
      expect(directMessages()).toHaveLength(1);
      expect(transcript(answered.message.place.chat.id)).toEqual([
        { text: "Rome writes first", fromRome: true },
        { text: "and the person answers", fromRome: false },
      ]);
    });
  });
}

export { deferred };
