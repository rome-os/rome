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
import type { ChannelChatAdapter, ChatAdapters, Inbound } from "./chat-adapter.js";

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
  /** Each recording channel's adapter, by channel name. Empty while no one
   *  listens. */
  const recording = new Map<string, ChannelChatAdapter>();
  let listeners = 0;
  /** The adapter's keys of each message being heard, by its recorded id. */
  const hearing = new Map<number, { chat: string; key: string }>();

  /** The last recording queued in each place, by channel, chat and thread.
   *  An adapter delivers a place's messages one at a time, but a recording
   *  still running when recording stops outlives it, so the place's next one,
   *  delivered once recording starts again, waits for it here. */
  const tails = new Map<string, Promise<number | null>>();

  const recordOne = async (message: Inbound): Promise<number | null> => {
    const { via } = message;
    // What reaches an account Rome does not listen to never forms a chat.
    if (deps.listens?.(via.connectionId) === false) return null;
    const chat = deps.chats.start(message.chat, message.chatKind, message.chatName);
    // Recorded and raised in one step, with nothing run in between, so
    // MessageSaid's first listener acts before anything reads the message. A
    // redelivery carries the same key, records nothing and raises nothing.
    const recorded = deps.messages.record(
      messageToRome({
        key: message.key,
        place: placeIn(chat.ref, message.thread?.id),
        saidBy: {
          account: { platform: chat.ref.platform, id: message.sender.accountId },
          ...(message.sender.name === undefined ? {} : { name: message.sender.name }),
        },
        body: { text: message.text, attachments: [...message.attachments] },
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        at: message.saidAt,
      }),
    );
    if (!recorded) return null;
    hearing.set(recorded.id, { chat: message.chat.externalId, key: message.key });
    try {
      await deps.events.publish({
        type: "MessageSaid",
        message: recorded,
        via: { channel: via.channel, account: via.account },
      });
    } finally {
      hearing.delete(recorded.id);
    }
    return recorded.id;
  };

  const deliver = (message: Inbound): Promise<number | null> => {
    const key = `${message.via.channel}\0${message.chat.externalId}\0${message.thread?.id ?? ""}`;
    const recorded = (tails.get(key) ?? Promise.resolve(null)).then(() => recordOne(message));
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
    const adapter = deps.adapters.of(channel);
    recording.set(channel.name, adapter);
    adapter.start(deliver, () => {
      // The adapter's channel reports a failed recording itself.
    });
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
        for (const adapter of recording.values()) void adapter.stop();
        recording.clear();
      };
    },
    heard(channel, id) {
      const keys = hearing.get(id);
      return keys && recording.get(channel)?.heard(keys.chat, keys.key);
    },
    addChannels(added) {
      known.push(...added);
      if (listeners > 0) for (const channel of added) subscribe(channel);
    },
  };
}
