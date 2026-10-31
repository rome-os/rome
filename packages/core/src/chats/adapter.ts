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
  OutgoingAttachment,
  StreamAgentEvent,
  Channel,
  ChannelMessage,
  ChatId,
  InboundEvent,
} from "@rome-os/app-runtime";
import { v7 as uuidv7 } from "uuid";
import { createLogger } from "../logger.js";
import type { MessagePart } from "../types.js";
import type { ChatKind } from "./chat.js";
import type { ChannelSend } from "../channels/channel.js";
import type { ChatAddresses } from "../channels/chat-addresses.js";
import { ReplyDelivery, type ReplyOutcome } from "../channels/delivery/reply.js";
import type { DeliveryPolicy } from "../channels/delivery/types.js";
import type { Clock } from "../lib/clock.js";
import {
  ChatIds,
  chatKey,
  directMessageOn,
  notOwnedBy,
  otherEndOf,
  ownedBy,
  type ChatKey,
} from "../channels/chat-ids.js";
import type { ChatRef, Place } from "./place.js";

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
   * Which of Rome's accounts heard it, and where, for the seat of that
   * account in Agents, which still keys it by the channel's address. Never
   * part of Chats.
   */
  readonly via: {
    readonly channel: string;
    readonly account: Account;
    /** The Connection it came through. */
    readonly connectionId: string;
    /** The platform address it was said at, and the thread's parent. */
    readonly address: ChatId;
    readonly parentAddress?: ChatId;
  };
}

/** A message for {@link ChatAdapter.send}. `replyTo` is the adapter's id of
 *  the message it answers. */
export interface Outbound {
  readonly text: string;
  readonly parts?: readonly MessagePart[];
  readonly attachments?: readonly OutgoingAttachment[];
  readonly replyTo?: string;
  /** The agent turn it answers, which a platform may show it as. */
  readonly turnId?: string;
}

/**
 * One of Rome's accounts on a platform, as Chats reaches it. One instance per
 * account; `start` is called again only after `stop`.
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
  /**
   * Open a reply in chat `chatId` that is written as the agent's run goes,
   * or null where the channel cannot stream. It is sent as the platform
   * allows, maybe in several messages, and settles to one line: the text the
   * user was shown and the adapter's id for its first message, or null when
   * nothing showed. `replyTo` is the adapter's id of the message it answers.
   */
  stream?(
    chatId: string,
    threadId: ChatId | null,
    out: { readonly replyTo?: string; readonly policy: DeliveryPolicy; readonly clock: Clock },
  ): StreamedReply | null;
}

/** A reply {@link ChatAdapter.stream} is writing. */
export interface StreamedReply {
  accept(event: StreamAgentEvent): void;
  /** Stop writing at once. */
  stop(): void;
  /** Finish the reply, or stop it when the run was stopped, and answer what
   *  the user was shown. */
  settle(stopped: boolean): Promise<{
    readonly outcome: ReplyOutcome;
    readonly text: string;
    readonly id: string | null;
  }>;
}

export interface ChannelAdapterDeps {
  /** Rome's account on a channel, or null while its record knows none. */
  accountOf(channel: string): Account | null;
  platformOfChannel(channel: string): string;
  /** The channels layer's address store, where a direct message the
   *  platform gives an id of its own is reached. */
  addresses?: Pick<ChatAddresses, "bind" | "addressOf" | "keyAt">;
}

/**
 * The address a channel sends to in `place`: the thread's when it names one,
 * the other end of a direct message, else the chat's key.
 */
export function addressOf(place: Place): ChatId {
  if (place.threadId !== undefined) return place.threadId;
  const key = ChatIds.key(place.chat);
  return (otherEndOf(key) ?? key.externalId) as ChatId;
}

/**
 * The chat Rome's account on `platform` reaches at platform address
 * `address`. Without `dm` it is the group the address names. With `dm` it is
 * the direct message between Rome's end `dm.romeEnd` and `dm.other`, the
 * party at the other end, who is the address itself when not named.
 */
export function chatAt(
  platform: string,
  address: string,
  dm?: { readonly romeEnd: string; readonly other?: string },
): ChatRef {
  return ChatIds.chat(
    dm
      ? directMessageOn(platform, dm.romeEnd, address, dm.other ?? address)
      : chatKey(platform, address as ChatId),
  );
}

/** Whether `chat` is a direct message, which its id says. */
export function isDirectMessage(chat: ChatRef): boolean {
  return otherEndOf(ChatIds.key(chat)) !== null;
}

/** The id of the message the platform calls `platformMessageId` in `chat`,
 *  as Rome's account `romeEnd` heard or sent it. */
export function lineAt(chat: ChatRef, romeEnd: string, platformMessageId: string): string {
  return ChatIds.message(chat, ownedBy(ChatIds.key(chat), romeEnd, platformMessageId));
}

/** The platform's id for line `lineId` of `chat`, which Rome's account
 *  `romeEnd` sent or heard, or null for a line the platform gave no id. */
export function platformIdOfLine(chat: ChatRef, romeEnd: string, lineId: string): string | null {
  const id = ChatIds.platformMessage(chat.id, lineId);
  if (id === null || id.startsWith("rome:")) return null;
  return notOwnedBy(ChatIds.key(chat), romeEnd, id);
}

/**
 * The id a line Rome sent into `chat` through Rome's account `romeEnd` is
 * recorded under: the platform's id for it, or one the adapter gives it when
 * the platform answered none.
 */
export function sentLineId(
  chat: ChatRef,
  romeEnd: string,
  platformMessageId: string | undefined,
): string {
  if (platformMessageId === undefined) {
    log.debug("platform answered no message id", { chat: chat.id });
    return ChatIds.message(chat, `rome:${uuidv7()}`);
  }
  return ChatIds.message(chat, ownedBy(ChatIds.key(chat), romeEnd, platformMessageId));
}

/**
 * The adapter for one of today's channels. It keys each chat by the
 * platform's id, a direct message by its two ends, and passes the platform's
 * ids through behind the platform. Where the platform gives a direct message
 * an id of its own, it sends to the address the account heard the chat at,
 * and to the other end before it has heard it.
 */
/** The adapter over one of today's channels, which also hands the platform's
 *  event for a message it is delivering to what still reads it. */
export interface ChannelChatAdapter extends ChatAdapter {
  /** The event the platform delivered message `id` in, while `deliver` is
   *  running for it. The hook that hears recorded messages reads it; Chats
   *  never does. */
  heard(id: string): InboundEvent | undefined;
}

export function channelAdapter(channel: Channel, deps: ChannelAdapterDeps): ChannelChatAdapter {
  const account = (): Account =>
    deps.accountOf(channel.name) ?? {
      platform: deps.platformOfChannel(channel.name),
      id: channel.name,
    };
  let unsubscribe: (() => void) | null = null;
  let started = false;
  const inFlight = new Set<Promise<unknown>>();
  const delivering = new Map<string, InboundEvent>();

  /** Where the platform takes a message for `ref`: the thread's id, else
   *  where the account heard a direct message, else the chat's key. */
  const addressIn = (ref: ChatRef, threadId: ChatId | null): ChatId => {
    const key = ChatIds.key(ref);
    const heardAt =
      threadId === null && otherEndOf(key) !== null
        ? (deps.addresses?.addressOf(account(), key.externalId) ?? null)
        : null;
    return (heardAt ??
      addressOf(threadId === null ? { chat: ref } : { chat: ref, threadId })) as ChatId;
  };

  return {
    channel: channel.name,
    heard: (id) => delivering.get(id),
    get account() {
      return account();
    },

    start(deliver, fault) {
      if (started) throw new Error(`Adapter for ${channel.name} is already receiving`);
      started = true;
      if (!channel.inbound) return;
      unsubscribe = channel.inbound.subscribe(async (event) => {
        const handed = (async () => {
          if (!event.message.text?.trim() && event.message.attachments.length === 0) return;
          const saved = await materialized(channel, event);
          const inbound = toInbound(channel.name, saved.message.account ?? account(), saved);
          delivering.set(inbound.id, {
            ...saved,
            message: { ...saved.message, channel: channel.name },
          });
          // A direct message is reached where it was heard, which on some
          // platforms is an id of its own rather than the other end.
          if (inbound.chatKind === "dm" && inbound.thread === null) {
            deps.addresses?.bind(
              inbound.via.account,
              ChatIds.key(inbound.chat).externalId,
              saved.message.chatId,
            );
          }
          try {
            await deliver(inbound);
          } finally {
            delivering.delete(inbound.id);
          }
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
      started = false;
      await Promise.allSettled([...inFlight]);
    },

    async send(chatId, threadId, out) {
      const send = channel.send;
      if (!send) throw new Error(`Channel "${channel.name}" cannot send`);
      const own = account();
      const ref: ChatRef = { platform: own.platform, id: chatId };
      const replyTo = out.replyTo && platformIdOfLine(ref, own.id, out.replyTo);
      const receipt = await send.send(addressIn(ref, threadId), {
        text: out.text,
        ...(out.parts ? { parts: [...out.parts] } : {}),
        ...(out.attachments ? { attachments: [...out.attachments] } : {}),
        ...(replyTo ? { replyToMessageId: replyTo } : {}),
        ...(out.turnId ? { turnId: out.turnId } : {}),
      });
      return sentLineId(ref, own.id, receipt.messageId || undefined);
    },

    stream(chatId, threadId, out) {
      const replies = (channel.send as ChannelSend | undefined)?.replies;
      if (!replies) return null;
      const own = account();
      const ref: ChatRef = { platform: own.platform, id: chatId };
      const replyTo = out.replyTo && platformIdOfLine(ref, own.id, out.replyTo);
      const delivery = new ReplyDelivery({
        transport: replies.transport,
        pacer: replies.pacer,
        policy: out.policy,
        conversation: addressIn(ref, threadId),
        ...(replyTo ? { replyTo } : {}),
        clock: out.clock,
      });
      return {
        accept: (event) => delivery.accept(event),
        stop: () => void delivery.stop(),
        async settle(stopped) {
          const outcome = await (stopped ? delivery.stop() : delivery.finish());
          // Every part showed or may have: a create whose result is unknown
          // most likely landed, and nothing sends it again. A block's parts
          // split its source, and each block is a message of its own.
          const shown = outcome.parts;
          const text = shown
            .map(
              (part, i) =>
                (i > 0 && part.block !== shown[i - 1]!.block ? "\n\n" : "") + part.source,
            )
            .join("");
          if (shown.length === 0) return { outcome, text, id: null };
          // A reply the platform split settles to its first message's id. A
          // message whose create is unknown has no id, so the first one with
          // an id stands in.
          const first = shown.find((part) => part.receipt)?.receipt?.messageId;
          return { outcome, text, id: sentLineId(ref, own.id, first || undefined) };
        },
      };
    },
  };
}

/**
 * Every channel's adapter, built once per channel when first asked for, over
 * one set of deps wired at startup. A channel a Connection mints again, as
 * after a reconnect, gets an adapter of its own.
 */
export class ChatAdapters {
  private readonly built = new WeakMap<Channel, ChannelChatAdapter>();

  constructor(private readonly deps: Required<ChannelAdapterDeps>) {}

  /** The adapter over `channel`. */
  of(channel: Channel): ChannelChatAdapter {
    let adapter = this.built.get(channel);
    if (!adapter) {
      adapter = channelAdapter(channel, this.deps);
      this.built.set(channel, adapter);
    }
    return adapter;
  }

  /** Rome's account on channel `channel`: its record's, else the channel's
   *  name on its platform while the record knows none. */
  accountOn(channel: string): Account {
    return (
      this.deps.accountOf(channel) ?? {
        platform: this.deps.platformOfChannel(channel),
        id: channel,
      }
    );
  }

  /**
   * The chat channel `channel`'s account reaches at platform address
   * `address`: the group there, else the direct message the account heard
   * there, else the one with the party the address names.
   */
  chatAt(channel: string, address: string, kind: "group" | "dm"): ChatRef {
    const account = this.accountOn(channel);
    if (kind === "group") return chatAt(account.platform, address);
    const heard = this.deps.addresses.keyAt(account, address);
    return heard === null
      ? chatAt(account.platform, address, { romeEnd: account.id })
      : ChatIds.chat(chatKey(account.platform, heard as ChatId));
  }
}

/** The message `event` carries, as the adapter hands it to Chats. */
function toInbound(channelName: string, account: Account, event: InboundEvent): Inbound {
  const message = event.message;
  const { key, kind } = chatOf(account.platform, account.id, message);
  const ref = ChatIds.chat(key);
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
    id: ChatIds.message(ref, ownedBy(key, account.id, message.messageId)),
    sender: {
      accountId: message.senderId,
      name: message.senderDisplayName ?? message.senderId,
    },
    text: message.text ?? "",
    attachments: message.attachments,
    saidAt: message.timestamp,
    ...(replyTo ? { replyTo: ChatIds.message(ref, ownedBy(key, account.id, replyTo)) } : {}),
    via: {
      channel: channelName,
      account,
      connectionId: event.ref.connectionId,
      address: message.chatId,
      ...(message.parentChatId === undefined ? {} : { parentAddress: message.parentChatId }),
    },
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
