// Recording what reaches Rome on its channels, in Chats' own tables.
// Vocabulary: docs/domains/chats.md#message.
//
// Every answerable message a channel delivers is recorded in its chat before
// anything acts on it, whether or not an agent answers it, and raises
// MessageSaid. Agents hears it there and decides the wake
// (sessions/messages-said.ts). Nothing records through it until the Chats
// switch; `chats/inbound.ts` records into the legacy rows until then.

import type { Channel, InboundEvent } from "@rome-os/app-runtime";
import type { ChatRepository } from "../chats/storage/chat-repository.js";
import type { ChatEvents } from "../chats/storage/events.js";
import { messageToRome } from "../chats/storage/message.js";
import type { MessageRepository } from "../chats/storage/message-repository.js";
import { placeIn } from "../chats/storage/place.js";
import { createLogger } from "../logger.js";
import type { ChannelChatAdapter, ChatAdapters, Inbound } from "./chat-adapter.js";

const log = createLogger("inbound-recording");

/** Most (account, message) pairs remembered as heard, past which the oldest
 *  is forgotten. A redelivery comes soon after the delivery it repeats. */
const HEARD_CAPACITY = 10_000;

export interface InboundRecordingDeps {
  /** Starts the chat a message is said in, or finds it. */
  chats: Pick<ChatRepository, "start">;
  messages: Pick<MessageRepository, "record" | "idOf">;
  events: ChatEvents;
  /** Each channel's chat adapter, which hands over what the channel hears. */
  adapters: Pick<ChatAdapters, "of">;
  /** Whether Rome listens to the account behind connection `connectionId`,
   *  as its inbound port reads it. An account linked to an agent that is not
   *  loaded is still listened to, so what it receives is recorded and
   *  Participation decides whether anything answers it. */
  listens?: (connectionId: string) => boolean;
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
  /** The adapter's keys of each message being heard, by channel and recorded
   *  id. */
  const hearing = new Map<string, { chat: string; key: string }>();

  /** The last recording queued in each place, by platform, chat and thread.
   *  Each of Rome's accounts in a place delivers its messages through its own
   *  channel, and a recording still running when recording stops outlives
   *  it, so the place's next message, from any account or subscription,
   *  waits for it here. */
  const tails = new Map<string, Promise<number | null>>();

  /**
   * Which of Rome's accounts each recorded message was raised for, as
   * `<account>\0<id>`, oldest first. Where the platform numbers a chat's
   * messages once for everyone, two of Rome's accounts there hear the same
   * line: it is recorded once and raised for each, while a redelivery to the
   * same account raises nothing. Kept in memory, like the wakes in flight: a
   * restart forgets it, and a redelivery after one is raised again, for
   * Agents to find the line its session already took
   * (sessions/messages-said.ts).
   */
  const raised = new Set<string>();
  const raise = (account: string, id: number): boolean => {
    const key = `${account}\0${id}`;
    if (raised.has(key)) return false;
    raised.add(key);
    if (raised.size > HEARD_CAPACITY) {
      const oldest = raised.values().next().value;
      if (oldest !== undefined) raised.delete(oldest);
    }
    return true;
  };

  const recordOne = async (
    message: Inbound,
    subscription: { readonly adapter: ChannelChatAdapter },
  ): Promise<number | null> => {
    const { via } = message;
    // A message still queued when the last listener left is dropped, as it
    // is for any hook swap: nobody is there to hear it, even once a new
    // hook listens again.
    if (recording.get(via.channel) !== subscription) return null;
    // What reaches an account Rome does not listen to never forms a chat.
    if (deps.listens?.(via.connectionId) === false) return null;
    const chat = deps.chats.start(message.chat, message.chatKind, message.chatName);
    // Recorded and raised in one step, with nothing run in between, so
    // MessageSaid's first listener acts before anything reads the message. A
    // line on record already is raised only for an account it was not raised
    // for: a redelivery records nothing and raises nothing.
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
    const fresh = deps.messages.record(said);
    const id = fresh?.id ?? deps.messages.idOf(chat.ref, message.key);
    if (id === null || !raise(via.account.id, id)) return null;
    // Raised again for another account, the line is the one on record, as
    // this account heard it.
    const { replyTo: _quote, ...unquoted } = said;
    const recorded = fresh ?? { ...unquoted, id };
    const hearingAs = `${via.channel}\0${id}`;
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
    return recorded.id;
  };

  const deliver = (
    message: Inbound,
    subscription: { readonly adapter: ChannelChatAdapter },
  ): Promise<number | null> => {
    const key = `${message.chat.platform}\0${message.chat.externalId}\0${message.thread?.id ?? ""}`;
    const recorded = (tails.get(key) ?? Promise.resolve(null)).then(() =>
      recordOne(message, subscription),
    );
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
  };
}
