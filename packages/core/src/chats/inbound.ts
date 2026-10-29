// Recording what reaches Rome on its channels, and hearing it once recorded.
// Vocabulary: docs/domains/chats.md#message and
// docs/domains/participation.md#wake.
//
// Every answerable message a channel delivers is recorded in its chat before
// anything acts on it, whether or not an agent answers it. Participation hears
// it from MessageRecorded and decides the wake there.

import type {
  Account,
  Channel,
  InboundEvent,
  RecordedInboundEvent,
  RecordedMessages,
} from "@rome-os/app-runtime";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import { createLogger } from "../logger.js";
import type { ChatEvents } from "./events.js";
import type { MessageRepository } from "./message-repository.js";
import { messageToRome } from "./message.js";
import { chatKey, placeIn } from "./place.js";

const log = createLogger("chats-inbound");

export interface InboundRecordingDeps {
  /** Opens the chat a message is said in, or finds it. */
  chats: Pick<WebChatRepository, "ensureChannelChat">;
  messages: MessageRepository;
  events: ChatEvents;
  /** The platform a channel's accounts are on, for a message that names no
   *  account it arrived on. */
  platformOfChannel: (channel: string) => string;
  /** The agent of one of Rome's accounts, as the channel-message hook reads
   *  it. Null means the account takes an agent and has none, and Rome does not
   *  listen to it, so nothing it receives is recorded. */
  accountAgentOf?: (account: Account | string) => string | null | undefined;
}

export interface InboundRecording {
  /** Hearing each message once recorded. Recording runs only while someone
   *  subscribes here, so nothing is stored twice while a hook stores messages
   *  itself. */
  readonly recordedMessages: RecordedMessages;
  /** Record `channels` too, such as a second bot whose Talk first unlocked. */
  addChannels(channels: readonly Channel[]): void;
}

/**
 * Records what arrives on `channels` and on any channel added later. Each
 * channel is subscribed once, so a chat's messages are recorded one at a time
 * in arrival order (R4 of `ChannelInbound`), and each is heard by every
 * {@link RecordedMessages} subscriber before the chat's next one is recorded.
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

  const record = (channel: Channel) => async (event: InboundEvent) => {
    if (!event.message.text?.trim() && event.message.attachments.length === 0) return;
    // An account Rome holds without an agent is not listened to, so what
    // reaches it never forms a chat.
    if (deps.accountAgentOf?.(event.message.account ?? channel.name) === null) return;
    const saved = await materialized(channel, event);
    // Named by the channel it was recorded on, which a subscriber finds the
    // channel by to answer it.
    const heard = { ...saved, message: { ...saved.message, channel: channel.name } };
    const { message } = heard;
    const threadType = message.thread?.kind === "dm" ? "private" : "group";
    await deps.chats.ensureChannelChat({
      channel: channel.name,
      threadId: message.chatId,
      ...(message.parentChatId === undefined ? {} : { parentThreadId: message.parentChatId }),
      ...(message.thread?.name === undefined ? {} : { threadName: message.thread.name }),
      threadType,
      // A chat starts answered by main. Its own agent, when it has one, was
      // set through its settings, which start the chat's row themselves.
      agentName: "main",
    });
    const platform = message.account?.platform ?? deps.platformOfChannel(channel.name);
    const replyTo = message.replyTo?.messageId.trim();
    const recorded = await deps.messages.record(
      messageToRome({
        place: placeIn(
          chatKey(platform, message.parentChatId ?? message.chatId),
          message.parentChatId === undefined ? undefined : message.chatId,
        ),
        saidBy: {
          account: { platform, id: message.senderId },
          name: message.senderDisplayName ?? message.senderId,
        },
        body: { text: message.text ?? "", attachments: message.attachments },
        platformMessageId: message.messageId,
        ...(replyTo ? { replyTo } : {}),
        at: message.timestamp,
      }),
      { channel: channel.name, heard },
    );
    if (!recorded) return;
    // Handed to nobody, as while a hook is being swapped, nothing will decide
    // its wake, so it stands decided as a message no agent answered.
    if (!delivered.delete(recorded.id)) await deps.messages.wakeDecided(recorded.id);
  };

  const subscribe = (channel: Channel): void => {
    if (!channel.inbound || recording.has(channel.name)) return;
    recording.set(channel.name, channel.inbound.subscribe(record(channel)));
  };

  const recordedMessages: RecordedMessages = {
    subscribe(handler) {
      const unsubscribe = deps.events.subscribe(async (event) => {
        if (event.type !== "MessageRecorded" || !event.via.heard) return;
        const recorded: RecordedInboundEvent = {
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
    decided: (recorded) => deps.messages.wakeDecided(recorded.messageId),
  };

  return {
    recordedMessages,
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
