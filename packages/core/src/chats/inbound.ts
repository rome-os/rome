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
  /** Hearing each message once recorded. The first subscription starts the
   *  recording, so a host whose hook stores messages itself records nothing
   *  twice. Recording goes on after the last subscriber leaves. */
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
  const subscribed = new Set<string>();
  let started = false;

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
    await deps.messages.record(
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
  };

  const subscribe = (channel: Channel): void => {
    if (!channel.inbound || subscribed.has(channel.name)) return;
    subscribed.add(channel.name);
    channel.inbound.subscribe(record(channel));
  };

  const recordedMessages: RecordedMessages = {
    subscribe(handler) {
      const unsubscribe = deps.events.subscribe(async (event) => {
        if (event.type !== "MessageRecorded" || !event.via.heard) return;
        const recorded: RecordedInboundEvent = {
          ...event.via.heard,
          recorded: { chatRecordId: event.chatRecordId, messageId: event.message.id },
        };
        await handler(recorded);
      });
      if (!started) {
        started = true;
        for (const channel of known) subscribe(channel);
      }
      return unsubscribe;
    },
  };

  return {
    recordedMessages,
    addChannels(added) {
      known.push(...added);
      if (started) for (const channel of added) subscribe(channel);
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
