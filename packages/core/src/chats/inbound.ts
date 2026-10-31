// Recording what reaches Rome on its channels, and hearing it once recorded.
// Vocabulary: docs/domains/chats.md#message and
// docs/domains/participation.md#wake.
//
// Every answerable message a channel delivers is recorded in its chat before
// anything acts on it, whether or not an agent answers it. Participation hears
// it from MessageSaid and decides the wake there.

import type { Channel, MessagesSaid, SaidInboundEvent } from "@rome-os/app-runtime";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import type { TurnLinks } from "../sessions/turn-links.js";
import {
  channelAdapter,
  type ChannelAdapterDeps,
  type ChatAdapter,
  type Inbound,
} from "./adapter.js";
import type { ChatRepository } from "./chat-repository.js";
import type { ChatEvents } from "./events.js";
import type { MessageRepository } from "./message-repository.js";
import { messageToRome } from "./message.js";
import { placeIn } from "./place.js";

export interface InboundRecordingDeps {
  /** Starts the chat a message is said in, or finds it. */
  chats: Pick<ChatRepository, "start">;
  /** Opens the seat of Rome's account the message arrived on, in Agents. */
  seats: Pick<WebChatRepository, "ensureChannelChat" | "advanceActivity">;
  messages: Pick<MessageRepository, "record">;
  /** Holds a message out of every catch-up until its wake is decided. */
  wakes: Pick<TurnLinks, "wakeUndecided" | "wakeDecided" | "isWakeUndecided">;
  events: ChatEvents;
  /** What each channel's adapter needs: its account, and where it heard a
   *  direct message. */
  adapters: ChannelAdapterDeps;
  /** Whether Rome listens to the account behind connection `connectionId`,
   *  as its inbound port reads it. An account linked to an agent that is not
   *  loaded is still listened to, so what it receives is recorded and
   *  Participation decides whether anything answers it. */
  listens?: (connectionId: string) => boolean;
}

export interface InboundRecording {
  /** Hearing each message once recorded. Recording runs only while someone
   *  subscribes here, so nothing is stored twice while a hook stores messages
   *  itself. */
  readonly messagesSaid: MessagesSaid;
  /** Record `channels` too, such as a second bot whose Talk first unlocked. */
  addChannels(channels: readonly Channel[]): void;
}

/**
 * Records what arrives on `channels` and on any channel added later. Each
 * channel is subscribed once, so a chat's messages are recorded one at a time
 * in arrival order (R4 of `ChannelInbound`), and each is heard by every
 * {@link MessagesSaid} subscriber before the chat's next one is recorded.
 * A subscriber that is slow therefore holds up its chat's later messages, both
 * their recording and every subscriber's hearing them.
 */
export function inboundRecording(
  deps: InboundRecordingDeps,
  channels: readonly Channel[],
): InboundRecording {
  const known: Channel[] = [...channels];
  /** Each recording channel's adapter, by channel name. Empty while no one
   *  hears recorded messages. An adapter starts once, so a restart of
   *  recording takes a new one. */
  const recording = new Map<string, ChatAdapter>();
  let hearers = 0;
  /** The ids of recorded messages a subscriber was handed. */
  const delivered = new Set<string>();

  /** The last recording queued in each chat, by chat. An adapter delivers a
   *  chat's messages one at a time, but a recording still running when
   *  recording stops outlives its adapter, so the chat's next one, delivered
   *  to a later adapter, waits for it here. */
  const tails = new Map<string, Promise<string | null>>();

  const deliver = (message: Inbound): Promise<string | null> => {
    const key = `${message.via.channel}\0${message.chat.id}\0${message.thread?.id ?? ""}`;
    const recorded = (tails.get(key) ?? Promise.resolve(null)).then(() => recordOne(message));
    // A failed recording is the adapter's to report, and does not hold up the
    // chat's next message.
    const tail = recorded.catch(() => null);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return recorded;
  };

  const recordOne = async (message: Inbound): Promise<string | null> => {
    const { heard } = message.via;
    // What reaches an account Rome does not listen to never forms a chat.
    if (deps.listens?.(heard.ref.connectionId) === false) return null;
    const chat = deps.chats.start(message.chat, message.chatKind, message.chatName);
    const platformMessage = heard.message;
    const seat = await deps.seats.ensureChannelChat({
      channel: message.via.channel,
      threadId: platformMessage.chatId,
      ...(platformMessage.parentChatId === undefined
        ? {}
        : { parentThreadId: platformMessage.parentChatId }),
      ...(platformMessage.thread?.name === undefined
        ? {}
        : { threadName: platformMessage.thread.name }),
      threadType: message.chatKind === "dm" ? "private" : "group",
      // A chat starts answered by main. Its own agent, when it has one, was
      // set through its settings, which start the chat's row themselves.
      agentName: "main",
      chatId: chat.ref.id,
      accountId: message.via.account.id,
    });
    // Undecided before the message is recorded, so no catch-up reads it in
    // between. A redelivery carries the same id, records nothing, and leaves
    // its wake as it was.
    const { id } = message;
    const fresh = !deps.wakes.isWakeUndecided(id);
    deps.wakes.wakeUndecided(id);
    const recorded = await deps.messages
      .record(
        messageToRome({
          id,
          place: placeIn(chat.ref, message.thread?.id),
          saidBy: {
            account: { platform: chat.ref.platform, id: message.sender.accountId },
            ...(message.sender.name === undefined ? {} : { name: message.sender.name }),
          },
          body: { text: message.text, attachments: [...message.attachments] },
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
          at: message.saidAt,
        }),
      )
      .catch((error: unknown) => {
        if (fresh) deps.wakes.wakeDecided(id);
        throw error;
      });
    if (!recorded) {
      if (fresh) deps.wakes.wakeDecided(id);
      return null;
    }
    await deps.seats.advanceActivity(seat.id, recorded.at);
    const said = {
      ...heard,
      message: { ...heard.message, attachments: [...message.attachments] },
    };
    await deps.events.publish({
      type: "MessageSaid",
      message: recorded,
      chatRecordId: seat.id,
      via: { channel: message.via.channel, heard: said },
    });
    // Handed to nobody, as while a hook is being swapped, nothing will decide
    // its wake, so it stands decided as a message no agent answered.
    if (!delivered.delete(recorded.id)) deps.wakes.wakeDecided(recorded.id);
    return recorded.id;
  };

  const subscribe = (channel: Channel): void => {
    if (!channel.inbound || recording.has(channel.name)) return;
    const adapter = channelAdapter(channel, deps.adapters);
    recording.set(channel.name, adapter);
    adapter.start(deliver, () => {
      // The adapter's channel reports a failed recording itself.
    });
  };

  const messagesSaid: MessagesSaid = {
    subscribe(handler) {
      const unsubscribe = deps.events.subscribe(async (event) => {
        if (event.type !== "MessageSaid" || !event.via.heard) return;
        const recorded: SaidInboundEvent = {
          ...event.via.heard,
          recorded: { chatRecordId: event.chatRecordId, messageId: event.message.id },
        };
        delivered.add(event.message.id);
        await handler(recorded);
      });
      hearers += 1;
      for (const channel of known) subscribe(channel);
      let left = false;
      return () => {
        if (left) return;
        left = true;
        hearers -= 1;
        unsubscribe();
        // With nobody hearing, recording stops, so a hook that stores messages
        // itself, such as an older one a reload brings back, is the only one
        // storing them. Messages still waiting on a channel are dropped (R3),
        // as they are for any hook swap.
        if (hearers > 0) return;
        for (const adapter of recording.values()) void adapter.stop();
        recording.clear();
      };
    },
    decided: async (recorded) => deps.wakes.wakeDecided(recorded.messageId),
  };

  return {
    messagesSaid,
    addChannels(added) {
      known.push(...added);
      if (hearers > 0) for (const channel of added) subscribe(channel);
    },
  };
}
