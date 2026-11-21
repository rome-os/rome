// Recording what reaches Rome on its channels, in Chats' own tables.
// Vocabulary: docs/domains/chats.md#message.
//
// Every answerable message a channel delivers is recorded in its chat before
// anything acts on it, whether or not an agent answers it, and raises
// MessageSaid once for each of Rome's accounts that hears it. Agents hears it
// there and decides each account's wake (sessions/messages-said.ts).

import type { Channel, InboundEvent } from "@rome-os/app-runtime";
import type { ChatRepository } from "../chats/storage/chat-repository.js";
import type { ChatEvents } from "../chats/storage/events.js";
import { messageToRome, type RecordedMessage } from "../chats/storage/message.js";
import type { MessageRepository } from "../chats/storage/message-repository.js";
import { placeIn } from "../chats/storage/place.js";
import { createLogger } from "../logger.js";
import type { ChannelChatAdapter, ChatAdapters, Inbound } from "./chat-adapter.js";
import { DELIVERY_ACCEPT_TIMEOUT_MS, RecordingStopped } from "./types.js";

const log = createLogger("inbound-recording");

/** How long a recorded message waits for the other of Rome's accounts in its
 *  chat to hear it. */
const HEARD_FOR_MS = 10 * 60_000;

/** Raises waiting in one place at which it is reported as backing up, as
 *  many messages as a channel port holds per address. The place's next
 *  message is still recorded at once, and its raise still queued. */
export const RAISES_BACKING_UP = 100;

export interface InboundRecordingDeps {
  /** Starts the chat a message is said in, or finds it. */
  chats: Pick<ChatRepository, "start">;
  messages: Pick<MessageRepository, "record">;
  events: ChatEvents;
  /** Each channel's chat adapter, which hands over what the channel hears. */
  adapters: Pick<ChatAdapters, "of">;
  /** Whether Rome listens to the account behind connection `connectionId`,
   *  as its inbound port reads it. An account linked to an agent that is not
   *  loaded is still listened to, so what it receives is recorded and
   *  Participation decides whether anything answers it. */
  listens?: (connectionId: string) => boolean;
  /** How long a message may wait to be recorded before its acceptance
   *  rejects. Defaults to {@link DELIVERY_ACCEPT_TIMEOUT_MS}. */
  acceptTimeoutMs?: number;
  /** Holds recorded message `messageId` out of every read a turn makes from
   *  its record until its MessageSaid has been heard, answering the release.
   *  A listener that decides its wake holds it on its own for longer
   *  (docs/domains/participation.md#wake). */
  hold?: (messageId: number) => () => void;
}

export interface InboundRecording {
  /**
   * Record what the channels hear until the answered function is called.
   * Recording runs only while someone listens, so nothing is stored twice
   * while a hook stores messages itself.
   */
  listen(): () => void;
  /** The platform's event recorded message `id` arrived in on channel
   *  `channel`, from its record until its MessageSaid has been heard. */
  heard(channel: string, id: number): InboundEvent | undefined;
  /** Record `channels` too, such as a second bot whose Talk first unlocked. */
  addChannels(channels: readonly Channel[]): void;
  /** Resolves once every message the channels have handed over so far is
   *  recorded and its MessageSaid heard. */
  settled(): Promise<void>;
  /**
   * Settles once message `messageId`, said in `chatId` on `channel` through
   * Connection `connectionId`, is on record in its chat, whether recorded now
   * or found there already. Call it before the message is handed to the
   * channel's subscribers. It resolves at once when `channel` is not being
   * recorded, and when the message reaches an account Rome does not listen
   * to. It rejects when the message is dropped or fails before it is on
   * record, or is not on record within the timeout.
   */
  accepted(
    channel: string,
    ref: { connectionId: string; chatId: string; messageId: string },
  ): Promise<void>;
}

/**
 * Records what arrives on `channels` and on any channel added later. Each
 * channel's adapter is started once. A message is recorded as soon as its
 * channel hands it over, in the order handed, and its delivery settles then.
 * Only its MessageSaid waits, behind the raises of the place's earlier
 * messages, since a message's wake depends on the wakes before it. A listener
 * that is slow holds up the raises of its place's later messages, never their
 * record.
 */
export function inboundRecording(
  deps: InboundRecordingDeps,
  channels: readonly Channel[],
): InboundRecording {
  const known: Channel[] = [...channels];
  /** Each recording channel's subscription, by channel name. Empty while no
   *  one listens. A subscription is replaced when recording starts again, so
   *  what the old one still delivers is not recorded under the new one. */
  const recording = new Map<string, { readonly adapter: ChannelChatAdapter }>();
  let listeners = 0;
  /** The deliveries waiting for their message to be on record, by channel,
   *  Connection, chat and message id. */
  const waiting = new Map<
    string,
    Array<{
      resolve: () => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }>
  >();
  const waitKey = (
    channel: string,
    ref: { connectionId: string; chatId: string; messageId: string },
  ): string => [channel, ref.connectionId, ref.chatId, ref.messageId].join("\0");
  const settle = (key: string, error?: Error): void => {
    const waiters = waiting.get(key);
    if (!waiters) return;
    waiting.delete(key);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
  };
  const settleInbound = (message: Inbound, error?: Error): void => {
    const { via } = message;
    settle(
      waitKey(via.channel, {
        connectionId: via.connectionId,
        chatId: via.address,
        messageId: via.messageId,
      }),
      error,
    );
  };

  /** The platform's event of each message being heard, by channel and
   *  recorded id, from its record until its raise is heard. The adapter lets
   *  go of the event once the message is recorded. */
  const hearing = new Map<string, InboundEvent | undefined>();

  /** The raises queued in each place, oldest first, by platform, chat and
   *  thread. Each of Rome's accounts in a place delivers its messages through
   *  its own channel, and a raise still queued when recording stops outlives
   *  it, so the place's next raise, from any account or subscription, waits
   *  behind them here. */
  const raising = new Map<string, Promise<void>[]>();
  const placeOf = (message: Inbound): string =>
    `${message.chat.platform}\0${message.chat.externalId}\0${message.thread?.id ?? ""}`;

  /** The messages recorded lately, by chat and key, with the accounts that
   *  have heard each one, by platform and id, so a reconnected account that
   *  hears it again on a new channel is still the same account. A second of Rome's accounts hears a group message
   *  moments after the first, so a message is kept for {@link HEARD_FOR_MS}.
   *  A message that is no longer here when another account hears it, such as
   *  after a restart, raises nothing for that account. */
  const lately = new Map<
    string,
    { readonly message: RecordedMessage; readonly accounts: Set<string>; readonly at: number }
  >();
  const forget = (now: number): void => {
    for (const [key, entry] of lately) {
      if (now - entry.at < HEARD_FOR_MS) break;
      lately.delete(key);
    }
  };

  /** Queue MessageSaid for `recorded` as heard on `via`, behind the raises of
   *  its place's earlier messages, holding the platform's event for the
   *  listeners until they have heard it. */
  const raise = (
    recorded: RecordedMessage,
    message: Inbound,
    subscription: { readonly adapter: ChannelChatAdapter },
  ): void => {
    const { via } = message;
    // Held from its record until its MessageSaid is raised, let go once.
    let letGo = deps.hold?.(recorded.id);
    const release = (): void => {
      letGo?.();
      letGo = undefined;
    };
    const hearingAs = `${via.channel}\0${recorded.id}`;
    hearing.set(hearingAs, subscription.adapter.heard(message.chat.externalId, message.key));
    const place = placeOf(message);
    const queued = raising.get(place) ?? [];
    if (queued.length === RAISES_BACKING_UP) {
      log.warn("inbound raises backing up", {
        channel: via.channel,
        chat: message.chat.externalId,
        thread: message.thread?.id ?? null,
        waiting: queued.length,
      });
    }
    const raised = (queued.at(-1) ?? Promise.resolve())
      .then(async () => {
        // A raise still queued when the last listener left is dropped, as it
        // is for any hook swap: nobody is there to hear it, even once a new
        // hook listens again. The message stays on record.
        if (recording.get(via.channel) !== subscription) return;
        const heard = deps.events.publish({
          type: "MessageSaid",
          message: recorded,
          via: { channel: via.channel, account: via.account },
        });
        // Publishing calls the first listener at once, and Agents, listening
        // first, holds the message from there until its wake is decided.
        release();
        await heard;
      })
      .catch((error: unknown) => {
        // On record already, and its delivery settled: a failed raise holds
        // up nothing after it in the place.
        log.error("failed to raise a recorded message", {
          channel: via.channel,
          messageId: recorded.id,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        hearing.delete(hearingAs);
        // A raise that never started lets go here.
        release();
        // Raises finish in the order queued, so this one is the oldest.
        const waiting = raising.get(place);
        waiting?.shift();
        if (waiting?.length === 0) raising.delete(place);
      });
    queued.push(raised);
    raising.set(place, queued);
  };

  const recordOne = (
    message: Inbound,
    subscription: { readonly adapter: ChannelChatAdapter },
  ): number | null => {
    const { via } = message;
    // A message handed over after the last listener left is not recorded.
    if (recording.get(via.channel) !== subscription) {
      settleInbound(message, new RecordingStopped());
      return null;
    }
    // What reaches an account Rome does not listen to never forms a chat.
    if (deps.listens?.(via.connectionId) === false) {
      settleInbound(message);
      return null;
    }
    const chat = deps.chats.start(message.chat, message.chatKind, message.chatName);
    // Inserted at once, and held until decided: its MessageSaid is queued
    // behind its place's earlier ones. A message already on record raises
    // nothing: a redelivery, even after a restart, and a group message a
    // second of Rome's accounts hears.
    const said = messageToRome({
      key: message.key,
      place: placeIn(chat.ref, message.thread?.id),
      saidBy: {
        account: { platform: chat.ref.platform, id: message.sender.accountId },
        ...(message.sender.name === undefined ? {} : { name: message.sender.name }),
      },
      body: { text: message.text, attachments: [...message.attachments] },
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      at: message.saidAt,
    });
    const now = Date.now();
    forget(now);
    const latelyKey = `${chat.ref.id}\0${message.key}`;
    const hearer = `${via.account.platform}\0${via.account.id}`;
    const recorded = deps.messages.record(said);
    // On record, now or already: what its delivery waits for.
    settleInbound(message);
    if (recorded === null) {
      // On record already. Another of Rome's accounts heard it first, and
      // this account decides its own wake, on the same record. A redelivery
      // to an account that heard it already raises nothing.
      const earlier = lately.get(latelyKey);
      if (!earlier || earlier.accounts.has(hearer)) return null;
      earlier.accounts.add(hearer);
      // Who said it, as this account knows them: a platform can name the
      // same person by a different id to each app, as Feishu does.
      raise({ ...earlier.message, saidBy: said.saidBy }, message, subscription);
      return earlier.message.id;
    }
    lately.set(latelyKey, { message: recorded, accounts: new Set([hearer]), at: now });
    raise(recorded, message, subscription);
    return recorded.id;
  };

  const deliver = async (
    message: Inbound,
    subscription: { readonly adapter: ChannelChatAdapter },
  ): Promise<number | null> => {
    try {
      return recordOne(message, subscription);
    } catch (error) {
      // A failed record is the adapter's to report. Settles nothing a
      // successful record settled already.
      settleInbound(message, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  };

  const subscribe = (channel: Channel): void => {
    if (!channel.inbound || recording.has(channel.name)) return;
    const subscription = { adapter: deps.adapters.of(channel) };
    recording.set(channel.name, subscription);
    subscription.adapter.start(
      (message) => deliver(message, subscription),
      (error) => {
        log.error("failed to record an inbound message", {
          channel: channel.name,
          error: error.message,
        });
      },
    );
  };

  return {
    listen() {
      listeners += 1;
      for (const channel of known) subscribe(channel);
      let left = false;
      return () => {
        if (left) return;
        left = true;
        listeners -= 1;
        // With nobody listening, recording stops, so a hook that stores
        // messages itself, such as an older one a reload brings back, is the
        // only one storing them. Messages still waiting on a channel are
        // dropped, as they are for any hook swap.
        if (listeners > 0) return;
        for (const { adapter } of recording.values()) void adapter.stop();
        recording.clear();
        for (const key of [...waiting.keys()]) {
          settle(key, new RecordingStopped());
        }
      };
    },
    heard(channel, id) {
      return hearing.get(`${channel}\0${id}`);
    },
    async settled() {
      for (;;) {
        await Promise.all([...recording.values()].map(({ adapter }) => adapter.settled()));
        const queued = [...raising.values()].map((raises) => raises.at(-1));
        if (queued.length === 0) return;
        await Promise.all(queued);
      }
    },
    addChannels(added) {
      known.push(...added);
      if (listeners > 0) for (const channel of added) subscribe(channel);
    },
    accepted(channel, ref) {
      if (!recording.has(channel)) return Promise.resolve();
      const key = waitKey(channel, ref);
      return new Promise<void>((resolve, reject) => {
        const timeoutMs = deps.acceptTimeoutMs ?? DELIVERY_ACCEPT_TIMEOUT_MS;
        const timer = setTimeout(() => {
          const waiters = waiting.get(key);
          const index = waiters?.findIndex((waiter) => waiter.timer === timer) ?? -1;
          if (waiters && index >= 0) {
            waiters.splice(index, 1);
            if (waiters.length === 0) waiting.delete(key);
          }
          log.warn("inbound message not recorded in time", { channel, ...ref, timeoutMs });
          reject(new Error(`not recorded within ${timeoutMs}ms`));
        }, timeoutMs);
        const waiters = waiting.get(key) ?? [];
        waiters.push({ resolve, reject, timer });
        waiting.set(key, waiters);
      });
    },
  };
}
