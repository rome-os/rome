// What every adapter owes Chats, and the adapter over today's channels.
// Contract: docs/architecture/channels.md#chat-adapters.
//
// An adapter owns every id it hands Chats. It names a chat and a message by
// its own ids, unique across platforms, and turns them back into the
// platform's addresses when it sends. Chats mints no ids and reads no meaning
// into the ones it is given.

import type {
  Account,
  Attachment,
  Channel,
  ChannelMessage,
  ChatId,
  InboundEvent,
} from "@rome-os/app-runtime";
import { v7 as uuidv7 } from "uuid";
import { createLogger } from "../logger.js";
import type { MessagePart } from "../types.js";
import type { ChatKind } from "./chat.js";
import {
  addressOf,
  chatKey,
  directMessageOn,
  keyOf,
  messageIdIn,
  ownedBy,
  placeIn,
  refOf,
  type ChatKey,
  type ChatRef,
} from "./place.js";

const log = createLogger("chat-adapter");

/** A message said in a chat of the adapter's account by someone else. */
export interface Inbound {
  /** The chat, by the adapter's id for it. */
  readonly chat: ChatRef;
  readonly chatKind: ChatKind;
  /** The platform's name for a group, when it gives one. */
  readonly chatName: string | null;
  /** The thread it was said in, or null in the open chat. */
  readonly thread: { readonly id: ChatId; readonly name?: string } | null;
  /** The adapter's id for the message, unique across platforms. */
  readonly id: string;
  readonly sender: { readonly accountId: string; readonly name?: string };
  readonly text: string;
  readonly attachments: readonly Attachment[];
  readonly saidAt: Date;
  /** The quoted message, by the adapter's id for it. */
  readonly replyTo?: string;
  /**
   * What the platform said, for what still reads it by the platform's
   * address: the seat of the account in Agents, and the hook that hears
   * recorded messages. Never part of Chats.
   */
  readonly via: {
    readonly channel: string;
    readonly account: Account;
    readonly heard: InboundEvent;
  };
}

/** A message for {@link ChatAdapter.send}. `replyTo` is the adapter's id of
 *  the message it answers. */
export interface Outbound {
  readonly text: string;
  readonly parts?: readonly MessagePart[];
  readonly replyTo?: string;
  /** The agent turn it answers, which a platform may show it as. */
  readonly turnId?: string;
}

/**
 * One of Rome's accounts on a platform, as Chats reaches it. One instance per
 * account; `start` is called at most once.
 */
export interface ChatAdapter {
  /** The channel the account is reached on. */
  readonly channel: string;
  /** Rome's account. */
  readonly account: Account;
  /**
   * Begin receiving. `deliver` is called once for every message said in a
   * chat of this account by someone else, live, a chat's messages one at a
   * time in the platform's order, and awaited before the chat's next one. It
   * answers the id the message is on record under, or null when it was on
   * record already. Rome's own lines never come through here. `fault`
   * reports a message the adapter could not hand over.
   */
  start(deliver: (message: Inbound) => Promise<string | null>, fault: (error: Error) => void): void;
  /** Stop receiving. `deliver` is not called once it resolves. */
  stop(): Promise<void>;
  /**
   * Post `out` as one message in chat `chatId`, in thread `threadId` or the
   * open chat when null, and answer the adapter's id for it once the platform
   * took it. A refusal rejects with the platform's words. No retry.
   */
  send(chatId: string, threadId: ChatId | null, out: Outbound): Promise<string>;
}

export interface ChannelAdapterDeps {
  /** Rome's account on a channel, or null while its record knows none. */
  accountOf(channel: string): Account | null;
  platformOfChannel(channel: string): string;
  /** The platform address the channel's account heard chat `chatId` at,
   *  which a direct message with an id of its own is sent to. */
  addressIn?(channel: string, chatId: string): string | null;
}

/**
 * The adapter for one of today's channels. It keys each chat by the
 * platform's id, a direct message by its two ends, and passes the platform's
 * ids through behind the platform. Where the platform gives a direct message
 * an id of its own, it sends to the address the account heard the chat at,
 * and to the other end before it has heard it.
 */
export function channelAdapter(channel: Channel, deps: ChannelAdapterDeps): ChatAdapter {
  const account = (): Account =>
    deps.accountOf(channel.name) ?? {
      platform: deps.platformOfChannel(channel.name),
      id: channel.name,
    };
  let unsubscribe: (() => void) | null = null;
  let started = false;
  const inFlight = new Set<Promise<unknown>>();

  return {
    channel: channel.name,
    get account() {
      return account();
    },

    start(deliver, fault) {
      if (started) throw new Error(`Adapter for ${channel.name} already started`);
      started = true;
      if (!channel.inbound) return;
      unsubscribe = channel.inbound.subscribe(async (event) => {
        const handed = (async () => {
          if (!event.message.text?.trim() && event.message.attachments.length === 0) return;
          const saved = await materialized(channel, event);
          const inbound = toInbound(channel.name, saved.message.account ?? account(), saved);
          await deliver(inbound);
        })();
        inFlight.add(handed);
        try {
          await handed;
        } catch (error) {
          fault(error instanceof Error ? error : new Error(String(error)));
          throw error;
        } finally {
          inFlight.delete(handed);
        }
      });
    },

    async stop() {
      unsubscribe?.();
      unsubscribe = null;
      await Promise.allSettled([...inFlight]);
    },

    async send(chatId, threadId, out) {
      const send = channel.send;
      if (!send) throw new Error(`Channel "${channel.name}" cannot send`);
      const own = account();
      const ref: ChatRef = { platform: own.platform, id: chatId };
      const key = keyOf(ref);
      const heardAt =
        threadId === null && key.externalId.startsWith("dm:")
          ? (deps.addressIn?.(channel.name, chatId) ?? null)
          : null;
      const address = (heardAt ?? addressOf(placeIn(ref, threadId ?? undefined))) as ChatId;
      const receipt = await send.send(address, {
        text: out.text,
        ...(out.turnId ? { turnId: out.turnId } : {}),
      });
      if (receipt.messageId) return messageIdIn(ref, ownedBy(key, own.id, receipt.messageId));
      // The platform took it and gave no id: the adapter names it itself.
      log.debug("platform answered no message id", { channel: channel.name });
      return messageIdIn(ref, `rome:${uuidv7()}`);
    },
  };
}

/** The message `event` carries, as the adapter hands it to Chats. */
function toInbound(channelName: string, account: Account, event: InboundEvent): Inbound {
  const message = event.message;
  const heard: InboundEvent = { ...event, message: { ...message, channel: channelName } };
  const { key, kind } = chatOf(account.platform, account.id, message);
  const ref = refOf(key);
  const replyTo = message.replyTo?.messageId.trim();
  return {
    chat: ref,
    chatKind: kind,
    chatName: message.parentChatId === undefined ? (message.thread?.name ?? null) : null,
    thread:
      message.parentChatId === undefined
        ? null
        : {
            id: message.chatId,
            ...(message.thread?.name === undefined ? {} : { name: message.thread.name }),
          },
    id: messageIdIn(ref, ownedBy(key, account.id, message.messageId)),
    sender: {
      accountId: message.senderId,
      name: message.senderDisplayName ?? message.senderId,
    },
    text: message.text ?? "",
    attachments: message.attachments,
    saidAt: message.timestamp,
    ...(replyTo ? { replyTo: messageIdIn(ref, ownedBy(key, account.id, replyTo)) } : {}),
    via: { channel: channelName, account, heard },
  };
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
