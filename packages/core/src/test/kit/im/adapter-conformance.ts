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
import { recordedSends } from "../../../channels/recorded-sends.js";
import type { ChatAdapters } from "../../../chats/adapter.js";
import type { ChatRepository } from "../../../chats/chat-repository.js";
import type { MessageSaid } from "../../../chats/events.js";
import { inboundRecording } from "../../../chats/inbound.js";
import type { MessageRepository } from "../../../chats/message-repository.js";
import { placeIn } from "../../../chats/place.js";
import { WebChatRepository } from "../../../db/repositories/webchat.js";
import { chatWiring } from "../../../chat-wiring.js";
import { createTestDb, type TestDb } from "../../helpers.js";
import { deferred, type VisibleMessage } from "./peer.js";

/** A production adapter running against its platform's peer, with a person
 *  Rome's account can reach directly. */
export interface ConformanceChannel {
  /** Rome's account on the platform, as its channel record names it. */
  readonly account: Account;
  /** The adapter as a channel, which Chats' adapter is built over. */
  readonly channel: Channel;
  /** The person in a direct message with Rome's account, where the
   *  platform has direct messages. */
  readonly direct?: {
    /** The person's own address, where Rome opens a direct message to them. */
    readonly person: string;
    /** Where the platform shows that direct message. */
    readonly at: string;
    /** The person writes to Rome's account directly, and the platform's id
     *  for the message. */
    personWrites(text: string): string | Promise<string>;
  };
  /** A group Rome's account is in, where the peer models one. */
  readonly group?: {
    /** Where the platform shows the group. */
    readonly at: string;
    /** The person writes in the group, and the platform's id for it. */
    personWrites(text: string): string | Promise<string>;
  };
  /** A thread in `group`, where the platform has threads and the peer
   *  models one. */
  readonly thread?: {
    /** Where the platform shows the thread. */
    readonly at: string;
    /** The person writes in the thread, and the platform's id for it. */
    personWrites(text: string): string | Promise<string>;
  };
  /** Another of Rome's accounts on the platform, in `group` too, where the
   *  peer models two. */
  readonly second?: {
    readonly account: Account;
    readonly channel: Channel;
    /** The person writes in the group so both accounts hear it, and the
     *  platform's id for the message. */
    bothHear(text: string): string | Promise<string>;
  };
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
  /** What the platform has and the peer models. A case it cannot run is
   *  skipped, so the report shows it as a gap. */
  models: {
    /** Direct messages, as `direct` names them. */
    directMessages: boolean;
    /** Whether Rome may write first in a direct message. */
    romeWritesFirst: boolean;
    /** A group, as `group` names it. */
    groups: boolean;
    /** A second account of Rome's in the group, as `second` names it. */
    twoAccounts: boolean;
    /** A thread in the group, as `thread` names it. */
    threads: boolean;
  },
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
    /** The second account's send port, where the peer models one. */
    let secondSend: ChannelSend | undefined;
    /** The platform's refusal of the next send, when set. */
    let refusal: Error | null;

    beforeEach(async () => {
      testDb = createTestDb();
      peer = await start();
      const webchatRepo = new WebChatRepository(testDb.db);
      const own = [peer, ...(peer.second ? [peer.second] : [])];
      const wiring = chatWiring(testDb.db, {
        accountOf: (channel) => own.find((at) => at.channel.name === channel)?.account ?? null,
        platformOfChannel: () => peer.account.platform,
        channelsOn: (platform) =>
          platform === peer.account.platform ? own.map((at) => at.channel.name) : [],
        seats: webchatRepo,
      });
      ({ chats, messages, adapters } = wiring);
      said = [];
      wiring.events.subscribe(async (event) => {
        if (event.type === "MessageSaid") said.push(event);
      });
      stopRecording = inboundRecording(
        { chats, messages, events: wiring.events, adapters },
        own.map((at) => at.channel),
      ).listen();
      refusal = null;
      // The platform refuses what it is told to, as a real one refuses a
      // message it cannot take.
      const platformSend = peer.channel.send as ChannelSend;
      const refusing = Object.create(platformSend) as ChannelSend;
      Object.defineProperty(refusing, "send", {
        value: async (address: ChatId, message: OutgoingMessage) => {
          const refused = refusal;
          refusal = null;
          if (refused) throw refused;
          return platformSend.send(address, message);
        },
      });
      const [sending, secondSending] = recordedSends(
        [{ ...peer.channel, send: refusing }, ...(peer.second ? [peer.second.channel] : [])],
        { adapters, chats, webchatRepo, replies: wiring.replies, messages },
      );
      send = sending!.send as ChannelSend;
      secondSend = secondSending?.send as ChannelSend | undefined;
    });

    afterEach(async () => {
      stopRecording();
      await peer.stop();
      testDb.close();
    });

    /** The conversation the cases that need only one run in: the direct
     *  message where the platform has one, else the group. */
    const conversation = () => {
      const at = peer.direct ?? peer.group;
      if (!at) throw new Error("The peer models no conversation");
      return at;
    };

    /** The person writes `text` where `writes` says, in the conversation by
     *  default; resolves once Rome has it on record. */
    async function personSays(
      text: string,
      writes: (text: string) => string | Promise<string> = (said) =>
        conversation().personWrites(said),
    ): Promise<MessageSaid & { platformId: string }> {
      const before = said.length;
      const platformId = await writes(text);
      const deadline = Date.now() + 3_000;
      while (said.length === before) {
        if (Date.now() > deadline) throw new Error(`Rome recorded nothing of "${text}"`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return { ...said[before]!, platformId };
    }

    /** What Rome's transcript of the chat holds, oldest first. */
    const transcript = (chatId: number) =>
      messages
        .read(placeIn({ platform: peer.account.platform, id: chatId }), { limit: 50 })
        .messages.map((message) => ({
          text: message.body.text,
          fromRome: message.saidBy?.agent !== undefined,
        }));

    /** The platform's chats Rome holds, of `kind`. */
    const chatsOf = (kind: "dm" | "group") =>
      chats.list(peer.account.platform).filter((chat) => chat.kind === kind);
    const directMessages = () => chatsOf("dm");

    (models.directMessages ? it : it.skip)(
      "records a direct message once, in one chat, as the person's",
      async () => {
        const heard = await personSays("hello Rome");

        expect(transcript(heard.message.place.chat.id)).toEqual([
          { text: "hello Rome", fromRome: false },
        ]);
        expect(directMessages()).toHaveLength(1);
      },
    );

    (models.directMessages ? it : it.skip)(
      "sends a reply to a direct message where the person sees it, and records it there",
      async () => {
        const heard = await personSays("hello Rome");

        // Rome answers at the person's address, as a hook or an agent names it.
        await send.send(peer.direct!.person as ChatId, { text: "hello back" });

        expect(peer.visible(peer.direct!.at).map((m) => [m.from, m.text])).toEqual([
          ["user", "hello Rome"],
          ["rome", "hello back"],
        ]);
        expect(transcript(heard.message.place.chat.id)).toEqual([
          { text: "hello Rome", fromRome: false },
          { text: "hello back", fromRome: true },
        ]);
        expect(directMessages()).toHaveLength(1);
      },
    );

    (models.directMessages ? it : it.skip)(
      "sends a reply to the address the direct message was heard at",
      async () => {
        const heard = await personSays("hello Rome");

        // The place a reply goes to is the one Rome heard the chat at.
        await send.send(peer.direct!.at as ChatId, { text: "hello again" });

        expect(peer.visible(peer.direct!.at).at(-1)).toMatchObject({
          from: "rome",
          text: "hello again",
        });
        expect(transcript(heard.message.place.chat.id).at(-1)).toEqual({
          text: "hello again",
          fromRome: true,
        });
        expect(directMessages()).toHaveLength(1);
      },
    );

    (models.directMessages && models.romeWritesFirst ? it : it.skip)(
      "keeps a direct message Rome opened as the chat the person answers in",
      async () => {
        await send.send(peer.direct!.person as ChatId, { text: "Rome writes first" });
        const answered = await personSays("and the person answers");

        expect(peer.visible(peer.direct!.at).map((m) => [m.from, m.text])).toEqual([
          ["rome", "Rome writes first"],
          ["user", "and the person answers"],
        ]);
        expect(directMessages()).toHaveLength(1);
        expect(transcript(answered.message.place.chat.id)).toEqual([
          { text: "Rome writes first", fromRome: true },
          { text: "and the person answers", fromRome: false },
        ]);
      },
    );

    it("records a reply that quotes the person's message as a reply to that line", async () => {
      const heard = await personSays("which day?");

      await send.send(conversation().at as ChatId, {
        text: "Tuesday",
        replyToMessageId: heard.platformId,
      });

      const [answer] = messages.read(heard.message.place, { limit: 1 }).messages;
      expect(answer).toMatchObject({ body: { text: "Tuesday" }, replyTo: heard.message.id });
    });

    it("puts nothing on record when the platform refuses a send, and says why", async () => {
      const heard = await personSays("hello Rome");
      refusal = new Error("Bad Request: chat not found");

      await expect(send.send(conversation().at as ChatId, { text: "lost" })).rejects.toThrow(
        "chat not found",
      );

      expect(transcript(heard.message.place.chat.id)).toEqual([
        { text: "hello Rome", fromRome: false },
      ]);
      expect(peer.visible(conversation().at).map((m) => m.text)).toEqual(["hello Rome"]);
    });

    (models.groups ? it : it.skip)(
      "records a group's messages once, in the group's chat, and answers there",
      async () => {
        const group = peer.group!;
        const heard = await personSays("hello all", (text) => group.personWrites(text));

        await send.send(group.at as ChatId, { text: "hello group" });

        expect(peer.visible(group.at).map((m) => [m.from, m.text])).toEqual([
          ["user", "hello all"],
          ["rome", "hello group"],
        ]);
        expect(transcript(heard.message.place.chat.id)).toEqual([
          { text: "hello all", fromRome: false },
          { text: "hello group", fromRome: true },
        ]);
        expect(chatsOf("group").map((chat) => chat.ref.id)).toEqual([heard.message.place.chat.id]);
        expect(directMessages()).toHaveLength(0);
      },
    );
    (models.groups && models.twoAccounts ? it : it.skip)(
      "records a group message two of Rome's accounts hear once, in one chat both answer in",
      async () => {
        const group = peer.group!;
        const heard = await personSays("hello both", (text) => peer.second!.bothHear(text));
        // Give the second account the time the first took to deliver it.
        await new Promise((resolve) => setTimeout(resolve, 200));

        await send.send(group.at as ChatId, { text: "from the first" });
        await secondSend!.send(group.at as ChatId, { text: "from the second" });

        // How the platform shows the person naming the other account is the
        // platform's, so the person's line is checked by its words.
        const lines = transcript(heard.message.place.chat.id);
        expect(lines).toHaveLength(3);
        expect(lines[0]).toMatchObject({ text: expect.stringContaining("hello both") });
        expect(lines.slice(1)).toEqual([
          { text: "from the first", fromRome: true },
          { text: "from the second", fromRome: true },
        ]);
        expect(said).toHaveLength(1);
        expect(chatsOf("group").map((chat) => chat.ref.id)).toEqual([heard.message.place.chat.id]);
        expect(
          messages
            .read(heard.message.place, { limit: 50 })
            .messages.filter((line) => line.direction === "fromRome")
            .map((line) => line.saidBy?.account.id),
        ).toEqual([peer.account.id, peer.second!.account.id]);
      },
    );
    (models.threads ? it : it.skip)(
      "records a thread's messages in the thread of its group's chat, and answers there",
      async () => {
        const thread = peer.thread!;
        const heard = await personSays("plans?", (text) => thread.personWrites(text));

        await send.send(thread.at as ChatId, { text: "Tuesday" });

        expect(heard.message.place.threadId).toBe(thread.at);
        expect(peer.visible(thread.at).map((m) => [m.from, m.text])).toEqual([
          ["user", "plans?"],
          ["rome", "Tuesday"],
        ]);
        expect(
          messages
            .read(heard.message.place, { limit: 50 })
            .messages.map((line) => [line.body.text, line.direction]),
        ).toEqual([
          ["plans?", "toRome"],
          ["Tuesday", "fromRome"],
        ]);
        // The thread stands in its group's chat, which holds no line of it.
        expect(chatsOf("group").map((chat) => chat.ref.id)).toEqual([heard.message.place.chat.id]);
        expect(transcript(heard.message.place.chat.id)).toEqual([]);
      },
    );
  });
}

export { deferred };
