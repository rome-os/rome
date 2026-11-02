// What every adapter owes Chats, and the adapter over today's channels.
// Contract: docs/architecture/channels.md#chat-adapters.
//
// An adapter owns every key it hands Chats. It names a chat by a key unique
// on its platform and a message by a key unique in its chat, and turns them
// back into the platform's addresses when it sends. Chats gives each its own
// id and reads no meaning into the keys.

import type {
  Account,
  Attachment,
  OutgoingAttachment,
  StreamAgentEvent,
  Channel,
  ChannelMessage,
  ChatId,
  InboundEvent,
  OutgoingMessage,
} from "@rome-os/app-runtime";
import { v7 as uuidv7 } from "uuid";
import { createLogger } from "../logger.js";
import type { MessagePart } from "../types.js";
import type { ChatKind } from "../chats/storage/chat.js";
import type { ChannelSend } from "../channels/channel.js";
import { CONVERSATION_BUFFER_DEFAULTS } from "../channels/conversation-buffer.js";
import type { ChatAddresses } from "./chat-addresses.js";
import { ReplyDelivery, type ReplyOutcome } from "../channels/delivery/reply.js";
import type { DeliveryPolicy } from "../channels/delivery/types.js";
import type { Clock } from "../lib/clock.js";
import {
  chatKey,
  directMessageOn,
  notOwnedBy,
  otherEndOf,
  ownedBy,
  type ChatKey,
} from "./chat-ids.js";
import type { ChatRef, Place } from "../chats/storage/place.js";

export type { ChatKey };

const log = createLogger("chat-adapter");

/** Most messages a chat may hold waiting for `deliver`, as the channel
 *  port's buffer holds per address. Past it the oldest is dropped, which a
 *  live, at-most-once port allows. */
const QUEUE_CAPACITY = CONVERSATION_BUFFER_DEFAULTS.capacity;
/** Waiting messages at which a chat is reported as backing up. */
const QUEUE_WARNING = CONVERSATION_BUFFER_DEFAULTS.depthWarning;

/** A message said in a chat of the adapter's account by someone else. */
export interface Inbound {
  /** The chat, by the adapter's key for it. */
  readonly chat: ChatKey;
  readonly chatKind: ChatKind;
  /** The platform's name for a group, when it gives one. */
  readonly chatName: string | null;
  /** The thread it was said in, or null in the open chat. */
  readonly thread: { readonly id: ChatId; readonly name?: string } | null;
  /** The adapter's key for the message, unique in its chat. */
  readonly key: string;
  readonly sender: { readonly accountId: string; readonly name?: string };
  readonly text: string;
  readonly attachments: readonly Attachment[];
  readonly saidAt: Date;
  /** The quoted message, by the adapter's key for it. */
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

/** A message for {@link ChatAdapter.send}. `replyTo` is the adapter's key of
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
   * time, and awaited before the chat's next one. Each platform address's
   * messages come in the platform's order; a chat's threads are addresses of
   * their own and keep only their own order. It
   * answers the id Chats recorded the message under, or null when it was on
   * record already. Rome's own lines never come through here. `fault`
   * reports a message the adapter could not hand over.
   */
  start(deliver: (message: Inbound) => Promise<number | null>, fault: (error: Error) => void): void;
  /** Stop receiving. `deliver` is not called once it resolves. */
  stop(): Promise<void>;
  /**
   * Post `out` as one message in the chat keyed `chatKey`, in thread
   * `threadId` or the open chat when null, and answer where it landed once
   * the platform took it. A refusal rejects with the platform's words. No
   * retry.
   */
  send(chatKey: string, threadId: ChatId | null, out: Outbound): Promise<Sent>;
  /**
   * Open a reply in the chat keyed `chatKey` that is written as the agent's
   * run goes, or null where the channel cannot stream. It is sent as the
   * platform allows, maybe in several messages, and settles to one line: the
   * text the user was shown and the adapter's key for its first message, or
   * null when nothing showed. `replyTo` is the adapter's key of the message
   * it answers.
   */
  stream?(
    chatKey: string,
    threadId: ChatId | null,
    out: { readonly replyTo?: string; readonly policy: DeliveryPolicy; readonly clock: Clock },
  ): StreamedReply | null;
}

/**
 * A message the platform took: the adapter's key for it, and the thread it
 * landed in, or null for the open chat. A platform may place a message in
 * another thread than the one it was sent to, as Discord does when it opens
 * a thread for a reply in a channel.
 */
export interface Sent {
  readonly key: string;
  readonly threadId: ChatId | null;
}

/** A reply {@link ChatAdapter.stream} is writing. */
export interface StreamedReply {
  accept(event: StreamAgentEvent): void;
  /** Stop writing at once. */
  stop(): void;
  /** Finish the reply, or stop it when the run was stopped, and answer what
   *  the user was shown, and the thread its first message landed in, as
   *  {@link Sent} names it. */
  settle(stopped: boolean): Promise<{
    readonly outcome: ReplyOutcome;
    readonly text: string;
    readonly key: string | null;
    readonly threadId: ChatId | null;
  }>;
}

export interface ChannelAdapterDeps {
  /** Rome's account on a channel, or null while its record knows none. */
  accountOf(channel: string): Account | null;
  platformOfChannel(channel: string): string;
  /** The channels layer's address store, where a chat the platform reaches
   *  at an id other than its key is reached. */
  addresses?: Pick<ChatAddresses, "bind" | "addressOf" | "keyAt" | "bindThread" | "threadChatAt">;
}

/** How an adapter keys the chat a platform message was said in, and its
 *  kind, for Rome's account `account`. */
export type ChatKeying = (
  account: Account,
  message: ChannelMessage,
) => {
  key: ChatKey;
  kind: ChatKind;
};

/**
 * The address a channel sends to in the chat keyed `key`: the thread's when
 * `threadId` names one, the other end of a direct message, else the key.
 */
export function addressOf(key: ChatKey, threadId?: ChatId | null): ChatId {
  if (threadId !== undefined && threadId !== null) return threadId;
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
): ChatKey {
  return dm
    ? directMessageOn(platform, dm.romeEnd, address, dm.other ?? address)
    : chatKey(platform, address as ChatId);
}

/** Whether the chat keyed `key` is a direct message, which its key says. */
export function isDirectMessage(key: ChatKey): boolean {
  return otherEndOf(key) !== null;
}

/** The key of the message the platform calls `platformMessageId` in the chat
 *  keyed `chat`, as Rome's account `romeEnd` heard or sent it. */
export function lineAt(chat: ChatKey, romeEnd: string, platformMessageId: string): string {
  return ownedBy(chat, romeEnd, platformMessageId);
}

/** The platform's id for the line keyed `lineKey` in the chat keyed `chat`,
 *  which Rome's account `romeEnd` sent or heard, or null for a line the
 *  platform gave no id or that only another of Rome's accounts holds. */
export function platformIdOfLine(chat: ChatKey, romeEnd: string, lineKey: string): string | null {
  if (lineKey.startsWith("rome:")) return null;
  // Where each account numbers its own lines, a line another account holds
  // has no id this one can quote.
  const owned = ownedBy(chat, romeEnd, "");
  if (owned !== "" && !lineKey.startsWith(owned)) return null;
  return notOwnedBy(chat, romeEnd, lineKey);
}

/**
 * The key a line Rome sent into the chat keyed `chat` through Rome's account
 * `romeEnd` is recorded under: the platform's id for it, or one the adapter
 * gives it when the platform answered none.
 */
export function sentLineId(
  chat: ChatKey,
  romeEnd: string,
  platformMessageId: string | undefined,
): string {
  if (platformMessageId === undefined) {
    log.debug("platform answered no message id", { chat: chat.externalId });
    return `rome:${uuidv7()}`;
  }
  return ownedBy(chat, romeEnd, platformMessageId);
}

/** The adapter over one of today's channels, which also hands the platform's
 *  event for a message it is delivering to what still reads it. */
export interface ChannelChatAdapter extends ChatAdapter {
  /** The event the platform delivered the message keyed `key` in, in the
   *  chat keyed `chat`, while `deliver` is running for it. The hook that
   *  hears recorded messages reads it; Chats never does. */
  heard(chat: string, key: string): InboundEvent | undefined;
  /**
   * The chat key of the thread the account heard at platform address
   * `address`, or null when it heard none there. Only today's channel ports
   * name a thread by its address alone, so this goes with them: a sender
   * that holds a place sends to its chat and thread.
   */
  threadAt(address: string): ChatKey | null;
  /** Resolves once every message heard so far has been handed to `deliver`
   *  or reported to `fault`. */
  settled(): Promise<void>;
}

/**
 * The adapter for one of today's channels. It keys each chat by the
 * platform's id, a direct message by its two ends, and passes the platform's
 * ids through behind the platform. Where the platform gives a direct message
 * an id of its own, it sends to the address the account heard the chat at,
 * and to the other end before it has heard it.
 */
export function channelAdapter(
  channel: Channel,
  deps: ChannelAdapterDeps,
  keying: ChatKeying = (account, message) => chatOf(account.platform, account.id, message),
): ChannelChatAdapter {
  const account = (): Account =>
    deps.accountOf(channel.name) ?? {
      platform: deps.platformOfChannel(channel.name),
      id: channel.name,
    };
  let unsubscribe: (() => void) | null = null;
  let started = false;
  const inFlight = new Set<Promise<unknown>>();
  const delivering = new Map<string, InboundEvent>();
  /** Each chat's messages waiting for the one being handed over, by the
   *  chat's key. A chat is here while its queue drains. */
  const queues = new Map<string, InboundEvent[]>();

  /** Where the platform takes a message for the chat keyed `key`: the
   *  thread's id, else where the account reaches the chat when that is not
   *  its key, else the chat's own address. */
  /**
   * The thread a message sent to platform address `address` in the chat keyed
   * `key`, for thread `threadId`, landed in, by the address the platform
   * answered it at. A direct message has no threads: a new address there is
   * where the platform reaches the chat, as when a first message to someone
   * opens the conversation, and the account reaches the chat there after.
   */
  const landedIn = (
    key: ChatKey,
    address: ChatId,
    threadId: ChatId | null,
    answered: string | undefined,
  ): ChatId | null => {
    if (!answered || answered === address) return threadId;
    if (isDirectMessage(key)) {
      deps.addresses?.bind(account(), key.externalId, answered);
      return threadId;
    }
    return answered as ChatId;
  };

  const addressIn = (key: ChatKey, threadId: ChatId | null): ChatId => {
    if (threadId !== null) return threadId;
    const bound = deps.addresses?.addressOf(account(), key.externalId) ?? null;
    return (bound ?? addressOf(key)) as ChatId;
  };

  return {
    channel: channel.name,
    heard: (chat, key) => delivering.get(`${chat}\0${key}`),
    threadAt(address) {
      const own = account();
      const key = deps.addresses?.threadChatAt(own, address) ?? null;
      return key === null ? null : chatKey(own.platform, key as ChatId);
    },
    get account() {
      return account();
    },

    start(deliver, fault) {
      if (started) throw new Error(`Adapter for ${channel.name} is already receiving`);
      started = true;
      if (!channel.inbound) return;
      const handOver = async (event: InboundEvent) => {
        if (!event.message.text?.trim() && event.message.attachments.length === 0) return;
        const saved = await materialized(channel, event);
        const inbound = toInbound(channel.name, saved.message.account ?? account(), saved, keying);
        // A direct message is reached where it was heard, which on some
        // platforms is an id of its own rather than the other end.
        if (inbound.chatKind === "dm" && inbound.thread === null) {
          deps.addresses?.bind(inbound.via.account, inbound.chat.externalId, saved.message.chatId);
        }
        // A thread is reached at its own address, which names no chat:
        // noted for today's ports, which send to that address alone.
        if (inbound.thread !== null) {
          deps.addresses?.bindThread(
            inbound.via.account,
            inbound.thread.id,
            inbound.chat.externalId,
          );
        }
        const heardAs = `${inbound.chat.externalId}\0${inbound.key}`;
        delivering.set(heardAs, {
          ...saved,
          message: { ...saved.message, channel: channel.name },
        });
        try {
          await deliver(inbound);
        } finally {
          delivering.delete(heardAs);
        }
      };
      const drain = async (chat: string, queue: InboundEvent[]) => {
        for (let event = queue.shift(); event !== undefined; event = queue.shift()) {
          try {
            await handOver(event);
          } catch (error) {
            fault(error instanceof Error ? error : new Error(String(error)));
          }
        }
        queues.delete(chat);
      };
      unsubscribe = channel.inbound.subscribe(async (event) => {
        // The port orders each platform address's events and holds the next
        // until this handler returns, but a chat's threads are addresses of
        // their own. So the handler only queues the event on its chat, in the
        // order the port hands it over, and returns: the adapter hands a
        // chat's messages over one at a time, and none waits behind another
        // thread's at the port. The queue is bounded as the port's is.
        const chat = keying(event.message.account ?? account(), event.message).key.externalId;
        const waiting = queues.get(chat);
        if (waiting) {
          if (waiting.length >= QUEUE_CAPACITY) {
            const dropped = waiting.shift();
            log.warn("inbound message dropped: chat queue full", {
              channel: channel.name,
              chat,
              capacity: QUEUE_CAPACITY,
              messageId: dropped?.message.messageId,
            });
          }
          waiting.push(event);
          if (waiting.length === QUEUE_WARNING) {
            log.warn("inbound chat backing up", {
              channel: channel.name,
              chat,
              waiting: waiting.length,
            });
          }
          return;
        }
        const queue = [event];
        queues.set(chat, queue);
        const draining = drain(chat, queue).finally(() => inFlight.delete(draining));
        inFlight.add(draining);
      });
    },

    async stop() {
      unsubscribe?.();
      unsubscribe = null;
      started = false;
      await Promise.allSettled([...inFlight]);
    },

    async settled() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },

    async send(chat, threadId, out) {
      const send = channel.send;
      if (!send) throw new Error(`Channel "${channel.name}" cannot send`);
      const own = account();
      const ref = chatKey(own.platform, chat as ChatId);
      const replyTo = out.replyTo && platformIdOfLine(ref, own.id, out.replyTo);
      const address = addressIn(ref, threadId);
      const receipt = await send.send(address, outgoing(out, replyTo || undefined));
      return {
        key: sentLineId(ref, own.id, receipt.messageId || undefined),
        threadId: landedIn(ref, address, threadId, receipt.chatId),
      };
    },

    stream(chat, threadId, out) {
      const replies = (channel.send as ChannelSend | undefined)?.replies;
      if (!replies) return null;
      const own = account();
      const ref = chatKey(own.platform, chat as ChatId);
      const replyTo = out.replyTo && platformIdOfLine(ref, own.id, out.replyTo);
      const address = addressIn(ref, threadId);
      const delivery = new ReplyDelivery({
        transport: replies.transport,
        pacer: replies.pacer,
        policy: out.policy,
        conversation: address,
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
          if (shown.length === 0) return { outcome, text, key: null, threadId };
          // A reply the platform split settles to its first message's key. A
          // message whose create is unknown has no id, so the first one with
          // an id stands in.
          const first = shown.find((part) => part.receipt)?.receipt;
          return {
            outcome,
            text,
            key: sentLineId(ref, own.id, first?.messageId || undefined),
            threadId: landedIn(ref, address, threadId, first?.chatId),
          };
        },
      };
    },
  };
}

/** A platform's own adapter over one of its channels. */
export type PlatformAdapter = (
  channel: Channel,
  deps: Required<ChannelAdapterDeps>,
) => ChannelChatAdapter;

/**
 * Every channel's adapter, built once per channel when first asked for, over
 * one set of deps wired at startup. A channel a Connection mints again, as
 * after a reconnect, gets an adapter of its own.
 */
export class ChatAdapters {
  private readonly built = new WeakMap<Channel, ChannelChatAdapter>();

  constructor(
    private readonly deps: Required<ChannelAdapterDeps> & {
      /** The adapter's key for the chat `ref` names. Chats holds it. */
      keyOf(ref: ChatRef): ChatKey;
      /** The channels of Rome's accounts on `platform`. */
      channelsOn(platform: string): readonly string[];
      /** The adapters of platforms that have their own, by platform. Any
       *  other platform's channel gets the generic {@link channelAdapter}. */
      platforms?: Readonly<Record<string, PlatformAdapter>>;
    },
  ) {}

  /** The adapter over `channel`. */
  of(channel: Channel): ChannelChatAdapter {
    let adapter = this.built.get(channel);
    if (!adapter) {
      const own = this.deps.platforms?.[this.deps.platformOfChannel(channel.name)];
      adapter = own ? own(channel, this.deps) : channelAdapter(channel, this.deps);
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

  /** The channel Rome's account `account` speaks through, or null when no
   *  channel is that account. The inverse of {@link accountOn}. */
  channelOf(account: Account): string | null {
    return (
      this.deps
        .channelsOn(account.platform)
        .find((channel) => this.accountOn(channel).id === account.id) ?? null
    );
  }

  /** The adapter's key for the chat `ref` names. */
  keyOf(ref: ChatRef): ChatKey {
    return this.deps.keyOf(ref);
  }

  /** Where `channel`'s account reaches `place`: the thread's id, the address
   *  it heard a direct message at, else the chat's own address. */
  addressAt(channel: string, place: Place): ChatId {
    if (place.threadId !== undefined) return place.threadId;
    return directMessageAddress(
      this.accountOn(channel),
      this.deps.keyOf(place.chat),
      this.deps.addresses,
    ) as ChatId;
  }

  /**
   * The direct message channel `channel`'s account has with `other`, which
   * the channel reaches at `address`. The address is kept, so a send there
   * goes where the channel answered, as for a direct message it heard.
   */
  directMessageReached(channel: string, other: string, address: string): ChatKey {
    const account = this.accountOn(channel);
    const chat = chatAt(account.platform, address, { romeEnd: account.id, other });
    if (address !== other) this.deps.addresses.bind(account, chat.externalId, address);
    return chat;
  }

  /**
   * The chat channel `channel`'s account reaches at platform address
   * `address`: the group there, else the direct message the account heard
   * there, else the one with the party the address names.
   */
  chatAt(channel: string, address: string, kind: "group" | "dm"): ChatKey {
    const account = this.accountOn(channel);
    const bound = this.deps.addresses.keyAt(account, address);
    if (bound !== null) return chatKey(account.platform, bound as ChatId);
    if (kind === "group") return chatAt(account.platform, address);
    return chatAt(account.platform, address, { romeEnd: account.id });
  }
}

/** `out` as the channel port takes it, quoting the platform's `replyTo`. */
function outgoing(out: Outbound, replyTo: string | undefined): OutgoingMessage {
  return {
    text: out.text,
    ...(out.parts ? { parts: [...out.parts] } : {}),
    ...(out.attachments ? { attachments: [...out.attachments] } : {}),
    ...(out.turnId ? { turnId: out.turnId } : {}),
    ...(replyTo ? { replyToMessageId: replyTo } : {}),
  };
}

/** The direct message `account` has at platform address `address`: the one
 *  it heard there, else the one with the party the address names. */
export function directMessageAt(
  account: Account,
  address: string,
  addresses: Pick<ChatAddresses, "keyAt">,
): ChatKey {
  const heard = addresses.keyAt(account, address);
  return heard === null
    ? chatAt(account.platform, address, { romeEnd: account.id })
    : chatKey(account.platform, heard as ChatId);
}

/** Where `account` reaches the chat keyed `chat`: the address it heard or
 *  bound the chat at, else the other party of a direct message, else the
 *  chat's key. */
export function directMessageAddress(
  account: Account,
  chat: ChatKey,
  addresses: Pick<ChatAddresses, "addressOf">,
): string {
  return addresses.addressOf(account, chat.externalId) ?? addressOf(chat);
}

/** The message `event` carries, as the adapter hands it to Chats. */
function toInbound(
  channelName: string,
  account: Account,
  event: InboundEvent,
  keying: ChatKeying,
): Inbound {
  const message = event.message;
  const { key, kind } = keying(account, message);
  const replyTo = message.replyTo?.messageId.trim();
  return {
    chat: key,
    chatKind: kind,
    chatName: message.parentChatId === undefined ? (message.thread?.name ?? null) : null,
    thread:
      message.parentChatId === undefined
        ? null
        : {
            id: message.chatId,
            ...(message.thread?.name === undefined ? {} : { name: message.thread.name }),
          },
    key: ownedBy(key, account.id, message.messageId),
    sender: {
      accountId: message.senderId,
      name: message.senderDisplayName ?? message.senderId,
    },
    text: message.text ?? "",
    attachments: message.attachments,
    saidAt: message.timestamp,
    ...(replyTo ? { replyTo: ownedBy(key, account.id, replyTo) } : {}),
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
