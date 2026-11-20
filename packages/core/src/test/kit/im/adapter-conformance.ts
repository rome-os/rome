// The chat adapter conformance suite: what every adapter owes Chats, checked
// against a platform's peer through Rome's production paths. A case reads
// only what a person sees on the peer and what Rome's transcript holds, never
// an adapter's internals. Contract: docs/architecture/channels.md#chat-adapters.

import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type {
  Account,
  Channel,
  ChatId,
  MessageReceipt,
  OutgoingMessage,
} from "@rome-os/app-runtime";
import { chatsWiring } from "../../../chats-wiring.js";
import { channelMessageOf } from "../../../chats/connected-accounts/channel-message.js";
import type { ChannelSend } from "../../../chats/connected-accounts/connected-account.js";
import type { ChatRepository } from "../../../chats/storage/chat-repository.js";
import { ChatEvents, type MessageSaid } from "../../../chats/storage/events.js";
import type { MessageRepository } from "../../../chats/storage/message-repository.js";
import { type Place, placeIn } from "../../../chats/storage/place.js";
import { EMAIL_PLATFORM } from "../../../connections/email-chat-adapter.js";
import { inboundRecording } from "../../../connections/inbound-recording.js";
import type * as connections from "../../../connections/message.js";
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
    /** How a person sees what `personWrites` sent, where the platform adds
     *  to the words, as a mention of Rome's account. The words alone by default. */
    shows?(text: string): string;
    /** A lookup the adapter makes on the platform before it hands a message
     *  over, where it makes one, such as a reply's author. `hold` holds the
     *  platform's next answer to it until released; `personWrites` writes a
     *  message in the group that needs it, and the platform's id for it. */
    readonly lookup?: {
      hold(): { entered: Promise<void>; release(): void };
      personWrites(text: string): string | Promise<string>;
    };
  };
  /** A thread in `group`, where the platform has threads and the peer
   *  models one. */
  readonly thread?: {
    /** Where the platform shows the thread. */
    readonly at: string;
    /** The person writes in the thread, and the platform's id for it. */
    personWrites(text: string): string | Promise<string>;
    /** As `group.shows`. */
    shows?(text: string): string;
  };
  /** Another of Rome's accounts on the platform, in `group` too, where the
   *  peer models two. */
  readonly second?: {
    readonly account: Account;
    readonly channel: Channel;
    /** The person writes in the group so both accounts hear it, and the
     *  platform's id for the message. */
    bothHear(text: string): string | Promise<string>;
    /** The person addresses this account alone in the group, where the peer
     *  models it: by a mention, or by replying to the account's message
     *  `messageId`; or addresses neither account. Both accounts hear it, the
     *  first account first. Each answers the platform's id. */
    alone?: {
      mentions(text: string): string | Promise<string>;
      repliesTo(messageId: string, text: string): string | Promise<string>;
      addressesNeither(text: string): string | Promise<string>;
    };
  };
  /** What a person in conversation `at` sees there. */
  visible(at: string): VisibleMessage[];
  /** The platform refuses the next message Rome's account sends, as it
   *  refuses one to a chat it does not know. */
  refuseNextSend(): void;
  stop(): Promise<void>;
}

/** A legacy channel adapter as the `Channel` ports Chats' adapter takes. Each
 *  message it hands over becomes what apps receive at the one point production
 *  turns it, so the cases read the same `ChannelMessage` an app would. */
export function channelOver(
  name: string,
  connectionId: string,
  adapter: {
    send(chatId: ChatId, message: OutgoingMessage): Promise<MessageReceipt>;
    onInbound(handler: (message: connections.Message) => Promise<void>): void;
  },
): Channel {
  const handlers = new Set<
    (
      event: Parameters<Parameters<NonNullable<Channel["inbound"]>["subscribe"]>[0]>[0],
    ) => Promise<void>
  >();
  adapter.onInbound(async (heard) => {
    const message = channelMessageOf(heard, name);
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
  | "oneOfTwoAccounts"
  | "thread"
  | "inOrder";

/**
 * Runs the conformance cases for the adapter `start` sets up. Each case gets
 * a fresh database, Rome's inbound recording and the hook send path over the
 * adapter, so what it checks is what Rome itself would do.
 *
 * The hook send path is a channel's send wrapped to go through the chat
 * adapter, which sends and records in one step, as production wires the
 * channels hooks send on.
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
    /** The person can address the second account alone, as `second.alone` names it. */
    oneOfTwoAccounts?: boolean;
    /** A thread in the group, as `thread` names it. */
    threads: boolean;
    /** A lookup the adapter waits on before handing a message over, as
     *  `group.lookup` names it. */
    lookups?: boolean;
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
    let messages: MessageRepository;
    let said: MessageSaid[];
    /** How each raise's message addressed the account it was raised for, as
     *  that account's adapter heard it. */
    let addressed: Map<MessageSaid, string | undefined>;
    let stopRecording: () => void;
    let send: (address: string, message: OutgoingMessage) => Promise<void>;
    /** The second account's send, where the peer models one. */
    let secondSend: ((address: string, message: OutgoingMessage) => Promise<void>) | undefined;

    beforeEach(async () => {
      testDb = createTestDb();
      peer = await start();
      const platform = peer.account.platform;
      const own = [peer, ...(peer.second ? [peer.second] : [])];
      const names = own.map((at) => at.channel.name);
      const wired = chatsWiring(testDb.db, {
        accountOf: (channel) => own.find((at) => at.channel.name === channel)?.account ?? null,
        platformOfChannel: () => platform,
        channelsOn: (on) => (on === platform ? names : []),
      });
      ({ chats, messages } = wired);
      const events = new ChatEvents();
      said = [];
      addressed = new Map();
      const recording = inboundRecording(
        { chats, messages, events, adapters: wired.adapters },
        own.map((at) => at.channel),
      );
      events.subscribe(async (event) => {
        if (event.type !== "MessageSaid") return;
        said.push(event);
        addressed.set(
          event,
          recording.heard(event.via.channel, event.message.id)?.message.addressing,
        );
      });
      stopRecording = recording.listen();
      // As a hook sends: at an address, through the channel's send wrapped
      // to go through the chat adapter.
      const sendOn = (channel: Channel) => {
        const [recorded] = wired.recordedSends([channel]);
        return async (address: string, message: OutgoingMessage): Promise<void> => {
          // An email quotes the email it answers by the provider's id, as a
          // reply to it, and reads no chat's quote hint.
          const { replyToMessageId, ...rest } = message;
          const out =
            platform === EMAIL_PLATFORM && replyToMessageId !== undefined
              ? ({
                  ...rest,
                  kind: "email",
                  inReplyToMessageId: replyToMessageId,
                } as OutgoingMessage)
              : message;
          await (recorded!.send as ChannelSend).send(address as ChatId, out);
        };
      };
      send = sendOn(peer.channel);
      secondSend = peer.second ? sendOn(peer.second.channel) : undefined;
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
      return { ...heard, platformId };
    }

    /** What Rome's transcript of `place` holds, oldest first. */
    const transcript = async (place: Place) =>
      messages.read(place, { limit: 50 }).messages.map((message) => ({
        text: message.body.text,
        fromRome: message.direction === "fromRome",
      }));

    /** The platform's chats Rome holds, of `kind`. */
    const chatsOf = (kind: "dm" | "group") =>
      chats
        .list(peer.account.platform)
        .filter((chat) => chat.kind === kind)
        .map((chat) => chat.ref.id);
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
      "records a reply that quotes the person's message as a reply to that message",
      async () => {
        const heard = await personSays("which day?");

        await send(conversation().at, { text: "Tuesday", replyToMessageId: heard.platformId });

        // The person sees the answer quote their message, and Rome's
        // transcript links the two the same way.
        expect(peer.visible(conversation().at).at(-1)).toMatchObject({
          text: "Tuesday",
          replyTo: heard.platformId,
        });
        const answer = messages.read(heard.message.place, { limit: 50 }).messages.at(-1);
        expect(answer?.body.text).toBe("Tuesday");
        expect(answer?.replyTo).toBe(heard.message.id);
      },
    );

    runs("refusal")(
      "puts nothing on record when the platform refuses a send, and fails the send",
      async () => {
        const heard = await personSays("hello Rome");
        peer.refuseNextSend();

        await expect(send(conversation().at, { text: "lost" })).rejects.toThrow();

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
          { text: group.shows?.("hello all") ?? "hello all", fromRome: false },
          { text: "hello group", fromRome: true },
        ]);
        expect(chatsOf("group")).toEqual([heard.message.place.chat.id]);
        expect(directMessages()).toHaveLength(0);
      },
    );

    runs("inOrder", models.groups && models.lookups === true)(
      "hands a chat's messages over in the order they arrived, however slow a lookup",
      async () => {
        const group = peer.group!;
        const lookup = group.lookup!;
        const shows = (text: string) => group.shows?.(text) ?? text;
        const held = lookup.hold();
        const before = said.length;

        await lookup.personWrites("first, which needs a lookup");
        await held.entered;
        await group.personWrites("second");
        // Give the second message the time to overtake the first, if it can.
        await new Promise((resolve) => setTimeout(resolve, 100));
        held.release();

        // A message the lookup needs, such as the one a reply answers, may
        // be recorded too; only the two the person wrote are compared.
        const written = [shows("first, which needs a lookup"), shows("second")];
        const recorded = () =>
          said
            .slice(before)
            .map((heard) => heard.message.body.text)
            .filter((text) => written.includes(text));
        const deadline = Date.now() + 3_000;
        while (recorded().length < 2) {
          if (Date.now() > deadline) throw new Error("Rome did not record both messages");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(recorded()).toEqual(written);
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
        // platform's, so the person's message is checked by its words.
        const lines = await transcript(heard.message.place);
        expect(lines).toHaveLength(3);
        expect(lines[0]).toMatchObject({ text: expect.stringContaining("hello both") });
        expect(lines.slice(1)).toEqual([
          { text: "from the first", fromRome: true },
          { text: "from the second", fromRome: true },
        ]);
        // Raised once for each account, so each decides its own wake.
        expect(new Set(said.map((event) => event.via.account.id))).toEqual(
          new Set([peer.account.id, peer.second!.account.id]),
        );
        expect(said.map((event) => event.message.id)).toEqual([heard.message.id, heard.message.id]);
        expect(chatsOf("group")).toEqual([heard.message.place.chat.id]);
      },
    );

    /** What Rome raised for a message `writes` sends, once both accounts
     *  have had the time to hear it. */
    async function raisedFor(writes: () => unknown): Promise<MessageSaid[]> {
      const before = said.length;
      await writes();
      const deadline = Date.now() + 3_000;
      while (said.length === before) {
        if (Date.now() > deadline) throw new Error("Rome recorded nothing");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      return said.slice(before);
    }

    /** How a message `writes` sends addressed each of Rome's accounts, by
     *  the account it was raised for, once both have had the time to hear it. */
    async function addressingFor(writes: () => unknown): Promise<Map<string, string | undefined>> {
      const raised = await raisedFor(writes);
      expect(new Set(raised.map((event) => event.message.id)).size).toBe(1);
      return new Map(raised.map((event) => [event.via.account.id, addressed.get(event)]));
    }

    const oneOfTwo = runs("oneOfTwoAccounts", models.groups && (models.oneOfTwoAccounts ?? false));

    oneOfTwo(
      "raises a message that mentions one of two of Rome's accounts for both, addressed to that one",
      async () => {
        const second = peer.second!;
        expect(await addressingFor(() => second.alone!.mentions("hi"))).toEqual(
          new Map([
            [peer.account.id, "ambient"],
            [second.account.id, "mention"],
          ]),
        );
      },
    );

    oneOfTwo(
      "raises a stop said to one of two of Rome's accounts for both, as a stop",
      async () => {
        const second = peer.second!;
        const raised = await raisedFor(() => second.alone!.mentions("/stop"));
        expect(raised.map((event) => [event.via.account, event.message.body.text])).toEqual([
          [peer.account, "/stop"],
          [second.account, "/stop"],
        ]);
        expect(raised.map((event) => addressed.get(event))).toEqual(["ambient", "mention"]);
      },
    );

    oneOfTwo(
      "raises a reply to one of two of Rome's accounts for both, addressed to that one",
      async () => {
        const second = peer.second!;
        const group = peer.group!;
        await secondSend!(group.at, { text: "noted" });
        const own = [...peer.visible(group.at)]
          .reverse()
          .find((message) => message.from === "rome")!;
        expect(await addressingFor(() => second.alone!.repliesTo(own.id, "thanks"))).toEqual(
          new Map([
            [peer.account.id, "ambient"],
            [second.account.id, "reply"],
          ]),
        );
      },
    );

    oneOfTwo(
      "raises a message addressed to neither of two of Rome's accounts for both, as ambient",
      async () => {
        const second = peer.second!;
        expect(await addressingFor(() => second.alone!.addressesNeither("anyone around?"))).toEqual(
          new Map([
            [peer.account.id, "ambient"],
            [second.account.id, "ambient"],
          ]),
        );
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
          { text: thread.shows?.("plans?") ?? "plans?", fromRome: false },
          { text: "Tuesday", fromRome: true },
        ]);
        // The thread stands in its group's chat, which holds no message of it.
        expect(await transcript(placeIn(heard.message.place.chat))).toEqual([]);
      },
    );
  });
}

export { deferred };
