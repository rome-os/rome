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
}

export interface InboundRecording {
  /**
   * Record what the channels hear until the answered function is called.
   * Recording runs only while someone listens, so nothing is stored twice
   * while a hook stores messages itself.
   */
  listen(): () => void;
  /** The platform's event recorded message `id` arrived in on channel
   *  `channel`, while it is being heard. */
  heard(channel: string, id: number): InboundEvent | undefined;
  /** Record `channels` too, such as a second bot whose Talk first unlocked. */
  addChannels(channels: readonly Channel[]): void;
  /**
   * Settles once message `messageId`, said in `chatId` on `channel` through
   * Connection `connectionId`, is on record in its chat, whether recorded now
   * or found there already. Call it before the message is handed to the
   * channel's subscribers. It resolves at once when recording never covers
   * `channel`, and when the message reaches an account Rome does not listen
   * to. It rejects with RecordingStopped when `channel` is covered but
   * nobody listens now, as during a hook swap, and when recording stops
   * before the message is on record. It rejects when the message is dropped
   * or fails before it is on record, or is not on record within the timeout.
   */
  accepted(
    channel: string,
    ref: { connectionId: string; chatId: string; messageId: string },
  ): Promise<void>;
}

/**
 * Records what arrives on `channels` and on any channel added later. Each
 * channel's adapter is started once, so a chat's messages are recorded one at
 * a time in arrival order, and each one's MessageSaid is heard by every
 * listener before the chat's next one is recorded. A listener that is slow
 * therefore holds up its chat's later messages.
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

  /** The adapter's keys of each message being heard, by channel and recorded
   *  id. */
  const hearing = new Map<string, { chat: string; key: string }>();

  /** The last recording queued in each place, by platform, chat and thread.
   *  Each of Rome's accounts in a place delivers its messages through its own
   *  channel, and a recording still running when recording stops outlives
   *  it, so the place's next message, from any account or subscription,
   *  waits for it here. */
  const tails = new Map<string, Promise<number | null>>();

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

  /** Raise MessageSaid for `recorded` as heard on `via`, holding the platform's
   *  event for the listeners while they hear it. */
  const raise = async (recorded: RecordedMessage, message: Inbound): Promise<void> => {
    const { via } = message;
    const hearingAs = `${via.channel}\0${recorded.id}`;
    hearing.set(hearingAs, { chat: message.chat.externalId, key: message.key });
    try {
      await deps.events.publish({
        type: "MessageSaid",
        message: recorded,
        via: { channel: via.channel, account: via.account },
      });
    } finally {
      hearing.delete(hearingAs);
    }
  };

  const recordOne = async (
    message: Inbound,
    subscription: { readonly adapter: ChannelChatAdapter },
  ): Promise<number | null> => {
    const { via } = message;
    // A message still queued when the last listener left is dropped, as it
    // is for any hook swap: nobody is there to hear it, even once a new
    // hook listens again.
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
    // Recorded and raised in one step, with nothing run in between, so
    // MessageSaid's first listener acts before anything reads the message. A
    // message already on record raises nothing: a redelivery, even after a
    // restart, and a group message a second of Rome's accounts hears.
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
      await raise({ ...earlier.message, saidBy: said.saidBy }, message);
      return earlier.message.id;
    }
    lately.set(latelyKey, { message: recorded, accounts: new Set([hearer]), at: now });
    await raise(recorded, message);
    return recorded.id;
  };

  const deliver = (
    message: Inbound,
    subscription: { readonly adapter: ChannelChatAdapter },
  ): Promise<number | null> => {
    const key = `${message.chat.platform}\0${message.chat.externalId}\0${message.thread?.id ?? ""}`;
    const recorded = (tails.get(key) ?? Promise.resolve(null))
      .then(() => recordOne(message, subscription))
      .catch((error: unknown) => {
        // Settles nothing a successful record settled already.
        settleInbound(message, error instanceof Error ? error : new Error(String(error)));
        throw error;
      });
    // A failed recording is the adapter's to report, and does not hold up the
    // place's next message.
    const tail = recorded.catch(() => null);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return recorded;
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
      const keys = hearing.get(`${channel}\0${id}`);
      return keys && recording.get(channel)?.adapter.heard(keys.chat, keys.key);
    },
    addChannels(added) {
      known.push(...added);
      if (listeners > 0) for (const channel of added) subscribe(channel);
    },
    accepted(channel, ref) {
      if (!recording.has(channel)) {
        // A channel recording covers but nobody listens to now, as between a
        // hook's swap and its return, records nothing until it is back: the
        // platform should deliver the message again. Only a channel recording
        // never covers counts its messages as accepted.
        const covered = known.some((each) => each.name === channel && each.inbound);
        return covered ? Promise.reject(new RecordingStopped()) : Promise.resolve();
      }
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
