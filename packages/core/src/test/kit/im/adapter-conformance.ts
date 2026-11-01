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
import { createAppRuntimeRepositories } from "../../../apps/repositories.js";
import type { ChannelSend } from "../../../channels/channel.js";
import { ChatRepository } from "../../../chats/chat-repository.js";
import { ChatEvents, type MessageSaid } from "../../../chats/events.js";
import { inboundRecording } from "../../../chats/inbound.js";
import { StoredMessages } from "../../../chats/message-repository.js";
import { chatKey, type Place, placeIn } from "../../../chats/place.js";
import { SettingsRepository } from "../../../db/repositories/settings.js";
import { WebChatRepository } from "../../../db/repositories/webchat.js";
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

/** The cases every adapter runs, by the name a gap is listed under. */
export type ConformanceCase =
  | "directMessageOnce"
  | "replyToPerson"
  | "replyWhereHeard"
  | "romeWritesFirst"
  | "quote"
  | "refusal"
  | "group"
  | "twoAccounts"
  | "thread";

/**
 * Runs the conformance cases for the adapter `start` sets up. Each case gets
 * a fresh database, Rome's inbound recording and the hook send path over the
 * adapter, so what it checks is what Rome itself would do.
 *
 * Today's hook send path is an app's: the channel's send, then the chat
 * repository the app runtime hands apps, as the system app's `send_message`
 * records a delivered message. When sends move behind the chat adapter, this
 * is the one place the suite changes.
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
  /**
   * Cases Rome fails on this platform today, each with why. They are
   * skipped, so the report lists them as gaps, and the step of the Chats
   * migration that closes one removes it here.
   */
  gaps: Partial<Record<ConformanceCase, string>> = {},
): void {
  /** A case that runs when the platform has what it needs and Rome has no
   *  known gap there. */
  const runs = (id: ConformanceCase, modelled = true) => (modelled && !gaps[id] ? it : it.skip);

  describe(`chat adapter conformance: ${name}`, () => {
    let testDb: TestDb;
    let peer: ConformanceChannel;
    let chats: ChatRepository;
    let messages: StoredMessages;
    let said: MessageSaid[];
    let stopRecording: () => void;
    let send: (address: string, message: OutgoingMessage) => Promise<void>;
    /** The second account's send, where the peer models one. */
    let secondSend: ((address: string, message: OutgoingMessage) => Promise<void>) | undefined;
    /** The platform's refusal of the next send, when set. */
    let refusal: Error | null;
    /** Every address a case named, where Rome may hold a chat. */
    let addresses: Set<string>;

    beforeEach(async () => {
      testDb = createTestDb();
      peer = await start();
      const platform = peer.account.platform;
      const own = [peer, ...(peer.second ? [peer.second] : [])];
      const names = own.map((at) => at.channel.name);
      const accountOf = (channel: string) =>
        own.find((at) => at.channel.name === channel)?.account ?? null;
      const rows = new WebChatRepository(testDb.db);
      const events = new ChatEvents();
      chats = new ChatRepository(testDb.db, {
        namesOn: (on) => (on === platform ? names : []),
        accountOf,
        platformOfChannel: () => platform,
      });
      messages = new StoredMessages(rows, events, {
        channelsOn: (on) => (on === platform ? names : []),
        accountOf,
      });
      said = [];
      addresses = new Set();
      events.subscribe(async (event) => {
        if (event.type === "MessageSaid") said.push(event);
      });
      // Recording runs while someone hears what is recorded.
      stopRecording = inboundRecording(
        { chats: rows, messages, events, platformOfChannel: () => platform },
        own.map((at) => at.channel),
      ).messagesSaid.subscribe(async () => undefined);
      refusal = null;
      const appChats = createAppRuntimeRepositories({
        settingsRepo: new SettingsRepository(testDb.db),
        webchatRepo: rows,
        chatRepo: chats,
        chatMessages: messages,
      }).chats!;
      const sendOn =
        (channel: Channel, refuses: boolean) =>
        async (address: string, message: OutgoingMessage): Promise<void> => {
          addresses.add(address);
          // The platform refuses what it is told to, as a real one refuses a
          // message it cannot take.
          const refused = refuses ? refusal : null;
          refusal = null;
          if (refused) throw refused;
          const receipt = await (channel.send as ChannelSend).send(address as ChatId, message);
          const conversation = await appChats.ensureChannelChat({
            channel: channel.name,
            threadId: address,
            agentName: "main",
            threadType: "private",
          });
          await appChats.recordOutboundMessage({
            sessionId: conversation.id,
            content: JSON.stringify([{ type: "text", content: message.text }]),
            ...(receipt.messageId ? { platformMessageId: receipt.messageId } : {}),
            senderId: "rome",
            senderName: "Rome",
            ...(message.replyToMessageId
              ? { replyToPlatformMessageId: message.replyToMessageId }
              : {}),
            knownToProvider: false,
          });
        };
      send = sendOn(peer.channel, true);
      secondSend = peer.second ? sendOn(peer.second.channel, false) : undefined;
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
      const heard = said[before]!;
      addresses.add(heard.message.place.threadId ?? heard.message.place.chat.id);
      return { ...heard, platformId };
    }

    /** What Rome's transcript of `place` holds, oldest first. */
    const transcript = async (place: Place) =>
      (await messages.recent(place, 50)).messages.map((message) => ({
        text: message.body.text,
        fromRome: message.direction === "fromRome",
      }));

    /** The chats of `kind` Rome holds at every address a case named. */
    const chatsOf = (kind: "dm" | "group") => {
      const found = new Map<string, string>();
      for (const address of addresses) {
        let chat;
        try {
          chat = chats.byKey(chatKey(peer.account.platform, address as ChatId), peer.account);
        } catch {
          chat = null;
        }
        if (chat?.kind === kind) found.set(`${chat.key.platform}:${chat.key.id}`, chat.key.id);
      }
      return [...found.values()];
    };
    const directMessages = () => chatsOf("dm");

    runs("directMessageOnce", models.directMessages)(
      "records a direct message once, in one chat, as the person's",
      async () => {
        const heard = await personSays("hello Rome");

        expect(await transcript(heard.message.place)).toEqual([
          { text: "hello Rome", fromRome: false },
        ]);
        expect(directMessages()).toHaveLength(1);
      },
    );

    runs("replyToPerson", models.directMessages)(
      "sends a reply to a direct message where the person sees it, and records it there",
      async () => {
        const heard = await personSays("hello Rome");

        // Rome answers at the person's address, as a hook or an agent names it.
        await send(peer.direct!.person, { text: "hello back" });

        expect(peer.visible(peer.direct!.at).map((m) => [m.from, m.text])).toEqual([
          ["user", "hello Rome"],
          ["rome", "hello back"],
        ]);
        expect(await transcript(heard.message.place)).toEqual([
          { text: "hello Rome", fromRome: false },
          { text: "hello back", fromRome: true },
        ]);
        expect(directMessages()).toHaveLength(1);
      },
    );

    runs("replyWhereHeard", models.directMessages)(
      "sends a reply to the address the direct message was heard at",
      async () => {
        const heard = await personSays("hello Rome");

        // The place a reply goes to is the one Rome heard the chat at.
        await send(peer.direct!.at, { text: "hello again" });

        expect(peer.visible(peer.direct!.at).at(-1)).toMatchObject({
          from: "rome",
          text: "hello again",
        });
        expect((await transcript(heard.message.place)).at(-1)).toEqual({
          text: "hello again",
          fromRome: true,
        });
        expect(directMessages()).toHaveLength(1);
      },
    );

    runs("romeWritesFirst", models.directMessages && models.romeWritesFirst)(
      "keeps a direct message Rome opened as the chat the person answers in",
      async () => {
        await send(peer.direct!.person, { text: "Rome writes first" });
        const answered = await personSays("and the person answers");

        expect(peer.visible(peer.direct!.at).map((m) => [m.from, m.text])).toEqual([
          ["rome", "Rome writes first"],
          ["user", "and the person answers"],
        ]);
        expect(directMessages()).toHaveLength(1);
        expect(await transcript(answered.message.place)).toEqual([
          { text: "Rome writes first", fromRome: true },
          { text: "and the person answers", fromRome: false },
        ]);
      },
    );

    runs("quote")(
      "records a reply that quotes the person's message as a reply to that line",
      async () => {
        const heard = await personSays("which day?");

        await send(conversation().at, { text: "Tuesday", replyToMessageId: heard.platformId });

        const [answer] = (await messages.recent(heard.message.place, 1)).messages;
        expect(answer?.body.text).toBe("Tuesday");
        expect(answer?.replyTo).toBe(heard.platformId);
      },
    );

    runs("refusal")(
      "puts nothing on record when the platform refuses a send, and says why",
      async () => {
        const heard = await personSays("hello Rome");
        refusal = new Error("Bad Request: chat not found");

        await expect(send(conversation().at, { text: "lost" })).rejects.toThrow("chat not found");

        expect(await transcript(heard.message.place)).toEqual([
          { text: "hello Rome", fromRome: false },
        ]);
        expect(peer.visible(conversation().at).map((m) => m.text)).toEqual(["hello Rome"]);
      },
    );

    runs("group", models.groups)(
      "records a group's messages once, in the group's chat, and answers there",
      async () => {
        const group = peer.group!;
        const heard = await personSays("hello all", (text) => group.personWrites(text));

        await send(group.at, { text: "hello group" });

        expect(peer.visible(group.at).map((m) => [m.from, m.text])).toEqual([
          ["user", "hello all"],
          ["rome", "hello group"],
        ]);
        expect(await transcript(heard.message.place)).toEqual([
          { text: "hello all", fromRome: false },
          { text: "hello group", fromRome: true },
        ]);
        expect(chatsOf("group")).toEqual([heard.message.place.chat.id]);
        expect(directMessages()).toHaveLength(0);
      },
    );

    runs("twoAccounts", models.groups && models.twoAccounts)(
      "records a group message two of Rome's accounts hear once, in one chat both answer in",
      async () => {
        const group = peer.group!;
        const heard = await personSays("hello both", (text) => peer.second!.bothHear(text));
        // Give the second account the time the first took to deliver it.
        await new Promise((resolve) => setTimeout(resolve, 200));

        await send(group.at, { text: "from the first" });
        await secondSend!(group.at, { text: "from the second" });

        // How the platform shows the person naming the other account is the
        // platform's, so the person's line is checked by its words.
        const lines = await transcript(heard.message.place);
        expect(lines).toHaveLength(3);
        expect(lines[0]).toMatchObject({ text: expect.stringContaining("hello both") });
        expect(lines.slice(1)).toEqual([
          { text: "from the first", fromRome: true },
          { text: "from the second", fromRome: true },
        ]);
        expect(said).toHaveLength(1);
        expect(chatsOf("group")).toEqual([heard.message.place.chat.id]);
      },
    );

    runs("thread", models.threads)(
      "records a thread's messages in the thread of its group's chat, and answers there",
      async () => {
        const thread = peer.thread!;
        const heard = await personSays("plans?", (text) => thread.personWrites(text));

        await send(thread.at, { text: "Tuesday" });

        expect(heard.message.place.threadId).toBe(thread.at);
        expect(peer.visible(thread.at).map((m) => [m.from, m.text])).toEqual([
          ["user", "plans?"],
          ["rome", "Tuesday"],
        ]);
        expect(await transcript(heard.message.place)).toEqual([
          { text: "plans?", fromRome: false },
          { text: "Tuesday", fromRome: true },
        ]);
        // The thread stands in its group's chat, which holds no line of it.
        expect(await transcript(placeIn(heard.message.place.chat))).toEqual([]);
      },
    );
  });
}

export { deferred };
