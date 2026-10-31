// Recording what reaches Rome on its channels. Vocabulary:
// docs/domains/chats.md#message.
//
// Every answerable message a channel delivers is recorded in its chat before
// anything acts on it, whether or not an agent answers it, and raises
// MessageSaid. Agents hears it there and decides the wake
// (sessions/messages-said.ts).

import type { Channel, InboundEvent } from "@rome-os/app-runtime";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import type { ChatAdapters, ChannelChatAdapter, Inbound } from "./adapter.js";
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
  /** The platform's event message `id` arrived in on channel `channel`,
   *  while it is being recorded and heard. */
  heard(channel: string, id: string): InboundEvent | undefined;
  /** Record `channels` too, such as a second bot whose Talk first unlocked. */
  addChannels(channels: readonly Channel[]): void;
}

/**
 * Records what arrives on `channels` and on any channel added later. Each
 * channel is subscribed once, so a chat's messages are recorded one at a time
 * in arrival order (R4 of `ChannelInbound`), and each one's MessageSaid is
 * heard by every listener before the chat's next one is recorded. A listener
 * that is slow therefore holds up its chat's later messages.
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

  /** The last recording queued in each chat, by chat. An adapter delivers a
   *  chat's messages one at a time, but a recording still running when
   *  recording stops outlives it, so the chat's next one, delivered once
   *  recording starts again, waits for it here. */
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
    const { via } = message;
    // What reaches an account Rome does not listen to never forms a chat.
    if (deps.listens?.(via.connectionId) === false) return null;
    const chat = deps.chats.start(message.chat, message.chatKind, message.chatName);
    const threadName = message.thread?.name ?? message.chatName ?? undefined;
    const seat = await deps.seats.ensureChannelChat({
      channel: via.channel,
      threadId: via.address,
      ...(via.parentAddress === undefined ? {} : { parentThreadId: via.parentAddress }),
      ...(threadName === undefined ? {} : { threadName }),
      threadType: message.chatKind === "dm" ? "private" : "group",
      // A chat starts answered by main. Its own agent, when it has one, was
      // set through its settings, which start the chat's row themselves.
      agentName: "main",
      chatId: chat.ref.id,
      accountId: message.via.account.id,
    });
    await deps.seats.advanceActivity(seat.id, message.saidAt);
    // Recorded and raised in one step, with nothing run in between, so
    // MessageSaid's first listener acts before anything reads the message. A
    // redelivery carries the same id, records nothing and raises nothing.
    const recorded = deps.messages.record(
      messageToRome({
        id: message.id,
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
    await deps.events.publish({
      type: "MessageSaid",
      message: recorded,
      chatRecordId: seat.id,
      via: { channel: via.channel },
    });
    return recorded.id;
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
        // dropped (R3), as they are for any hook swap.
        if (listeners > 0) return;
        for (const adapter of recording.values()) void adapter.stop();
        recording.clear();
      };
    },
    heard: (channel, id) => recording.get(channel)?.heard(id),
    addChannels(added) {
      known.push(...added);
      if (listeners > 0) for (const channel of added) subscribe(channel);
    },
  };
}
