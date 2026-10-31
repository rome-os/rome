// Recording what reaches Rome on its channels, and hearing it once recorded.
// Vocabulary: docs/domains/chats.md#message and
// docs/domains/participation.md#wake.
//
// Every answerable message a channel delivers is recorded in its chat before
// anything acts on it, whether or not an agent answers it. Participation hears
// it from MessageSaid and decides the wake there.

import type {
  Channel,
  ChannelMessage,
  InboundEvent,
  SaidInboundEvent,
  MessagesSaid,
} from "@rome-os/app-runtime";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import { createLogger } from "../logger.js";
import type { TurnLinks } from "../sessions/turn-links.js";
import type { ChatKind } from "./chat.js";
import type { ChatRepository } from "./chat-repository.js";
import type { ChatEvents } from "./events.js";
import type { MessageRepository } from "./message-repository.js";
import { messageToRome } from "./message.js";
import {
  chatKey,
  directMessageOn,
  messageIdIn,
  ownedBy,
  placeIn,
  refOf,
  type ChatKey,
} from "./place.js";

const log = createLogger("chats-inbound");

export interface InboundRecordingDeps {
  /** Starts the chat a message is said in, or finds it. */
  chats: Pick<ChatRepository, "start">;
  /** Opens the seat of Rome's account the message arrived on, in Agents. */
  seats: Pick<WebChatRepository, "ensureChannelChat" | "advanceActivity">;
  messages: Pick<MessageRepository, "record">;
  /** Holds a message out of every catch-up until its wake is decided. */
  wakes: Pick<TurnLinks, "wakeUndecided" | "wakeDecided" | "isWakeUndecided">;
  events: ChatEvents;
  /** The platform a channel's accounts are on, for a message that names no
   *  account it arrived on. */
  platformOfChannel: (channel: string) => string;
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
  /** Each recorded channel's unsubscribe, by channel name. Empty while no
   *  one hears recorded messages. */
  const recording = new Map<string, () => void>();
  let hearers = 0;
  /** The ids of recorded messages a subscriber was handed. */
  const delivered = new Set<string>();

  /** The last recording queued in each chat, by channel and chat. A channel
   *  delivers a chat's messages one at a time, but a recording still running
   *  when recording stops outlives its subscription, so the chat's next one,
   *  delivered to a later subscription, waits for it here. */
  const tails = new Map<string, Promise<void>>();

  const record = (channel: Channel) => (event: InboundEvent) => {
    const key = `${channel.name}\0${event.message.chatId}`;
    const recorded = (tails.get(key) ?? Promise.resolve()).then(() => recordOne(channel, event));
    // A failed recording is the channel's to report, and does not hold up the
    // chat's next message.
    const tail = recorded.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return recorded;
  };

  const recordOne = async (channel: Channel, event: InboundEvent) => {
    if (!event.message.text?.trim() && event.message.attachments.length === 0) return;
    // What reaches an account Rome does not listen to never forms a chat.
    if (deps.listens?.(event.ref.connectionId) === false) return;
    const saved = await materialized(channel, event);
    // Named by the channel it was recorded on, which a subscriber finds the
    // channel by to answer it.
    const heard = { ...saved, message: { ...saved.message, channel: channel.name } };
    const { message } = heard;
    const platform = message.account?.platform ?? deps.platformOfChannel(channel.name);
    // Rome's end of the chat: the account's platform id, or the channel's name
    // while its record knows none.
    const romeEnd = message.account?.id ?? channel.name;
    const { key, kind } = chatOf(platform, romeEnd, message);
    const chat = deps.chats.start(
      refOf(key),
      kind,
      message.parentChatId === undefined ? (message.thread?.name ?? null) : null,
    );
    const seat = await deps.seats.ensureChannelChat({
      channel: channel.name,
      threadId: message.chatId,
      ...(message.parentChatId === undefined ? {} : { parentThreadId: message.parentChatId }),
      ...(message.thread?.name === undefined ? {} : { threadName: message.thread.name }),
      threadType: kind === "dm" ? "private" : "group",
      // A chat starts answered by main. Its own agent, when it has one, was
      // set through its settings, which start the chat's row themselves.
      agentName: "main",
      chatId: chat.ref.id,
      accountId: romeEnd,
    });
    const replyTo = message.replyTo?.messageId.trim();
    // The adapter's id for the message: the platform's, in its chat. A
    // redelivery carries the same id and records nothing. Undecided before the
    // message is recorded, so no catch-up reads it in between; a redelivery
    // leaves its wake as it was.
    const id = messageIdIn(chat.ref, ownedBy(key, romeEnd, message.messageId));
    const fresh = !deps.wakes.isWakeUndecided(id);
    deps.wakes.wakeUndecided(id);
    const recorded = await deps.messages
      .record(
        messageToRome({
          id,
          place: placeIn(chat.ref, message.parentChatId === undefined ? undefined : message.chatId),
          saidBy: {
            account: { platform, id: message.senderId },
            name: message.senderDisplayName ?? message.senderId,
          },
          body: { text: message.text ?? "", attachments: message.attachments },
          ...(replyTo ? { replyTo: messageIdIn(chat.ref, ownedBy(key, romeEnd, replyTo)) } : {}),
          at: message.timestamp,
        }),
      )
      .catch((error: unknown) => {
        if (fresh) deps.wakes.wakeDecided(id);
        throw error;
      });
    if (!recorded) {
      if (fresh) deps.wakes.wakeDecided(id);
      return;
    }
    await deps.seats.advanceActivity(seat.id, recorded.at);
    await deps.events.publish({
      type: "MessageSaid",
      message: recorded,
      chatRecordId: seat.id,
      via: { channel: channel.name, heard },
    });
    // Handed to nobody, as while a hook is being swapped, nothing will decide
    // its wake, so it stands decided as a message no agent answered.
    if (!delivered.delete(recorded.id)) deps.wakes.wakeDecided(recorded.id);
  };

  const subscribe = (channel: Channel): void => {
    if (!channel.inbound || recording.has(channel.name)) return;
    recording.set(channel.name, channel.inbound.subscribe(record(channel)));
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
        for (const leave of recording.values()) leave();
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

/** `event` with its attachments saved where the channel can save them now.
 *  A channel that cannot, or fails to, leaves them as delivered. */
async function materialized(channel: Channel, event: InboundEvent): Promise<InboundEvent> {
  const media = channel.inbound?.media ?? null;
  if (!media || event.message.attachments.length === 0) return event;
  try {
    const attachments = await media.materialize(event.message);
    return { ...event, message: { ...event.message, attachments } };
  } catch (error) {
    log.error("failed to materialize incoming attachments", {
      channel: channel.name,
      messageId: event.message.messageId,
      error: error instanceof Error ? error.message : String(error),
    });
    return event;
  }
}

/** The chat a message is said in, and its kind. A thread's chat is its
 *  parent. */
function chatOf(
  platform: string,
  romeEnd: string,
  message: ChannelMessage,
): { key: ChatKey; kind: ChatKind } {
  if (message.parentChatId !== undefined) {
    return { key: chatKey(platform, message.parentChatId), kind: "group" };
  }
  if (message.thread?.kind !== "dm")
    return { key: chatKey(platform, message.chatId), kind: "group" };
  return {
    key: directMessageOn(platform, romeEnd, message.chatId, message.senderId),
    kind: "dm",
  };
}
