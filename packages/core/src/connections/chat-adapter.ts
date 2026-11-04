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
import { SendRefused } from "@rome-os/app-runtime";
import { v7 as uuidv7 } from "uuid";
import { createLogger } from "../logger.js";
import type { MessagePart } from "../types.js";
import type { ChatKind } from "../chats/storage/chat.js";
import type { ChannelSend } from "../chats/connected-accounts/connected-account.js";
import { CONVERSATION_BUFFER_DEFAULTS } from "../participation/conversation-buffer.js";
import type { ChatAddresses } from "./chat-addresses.js";
import { ReplyDelivery, type ReplyOutcome } from "../participation/reply-delivery/reply.js";
import type { DeliveryPolicy } from "./sending.js";
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
   * Which of Rome's accounts heard it, and where, for the speaker of that
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
   * record already. Rome's own messages never come through here. `fault`
   * reports a message the adapter could not hand over.
   */
  start(deliver: (message: Inbound) => Promise<number | null>, fault: (error: Error) => void): void;
  /** Stop receiving. What is still waiting to be handed over is dropped, and
   *  `deliver` is not called once it resolves. */
  stop(): Promise<void>;
  /**
   * Post `out` as one message in the chat keyed `chatKey`, in thread
   * `threadId` or the open chat when null, and answer where it landed once
   * the platform took it. A refusal rejects with the platform's words. A
   * message the channel cannot deliver as given, such as a `replyTo` the
   * account has no platform id for, rejects with `SendRefused` and
   * sends nothing. No retry.
   */
  send(chatKey: string, threadId: ChatId | null, out: Outbound): Promise<Sent>;
  /**
   * Open a reply in the chat keyed `chatKey` that is written as the agent's
   * run goes, or null where the channel cannot stream. It is sent as the
   * platform allows, maybe in several messages, and settles to each message
   * the user was shown, or may have been, in order: none when nothing showed.
   * `replyTo` is the adapter's key of the message it answers, and one the
   * account has no platform id for throws `SendRefused`.
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
  /** Finish the reply, or stop it when the run was stopped, and answer each
   *  message the user was shown, in order. */
  settle(stopped: boolean): Promise<{
    readonly outcome: ReplyOutcome;
    readonly shown: readonly ShownMessage[];
  }>;
}

/** One message of a streamed reply the platform shows: its text, and where
 *  it landed as {@link Sent} names it. A long reply is several of them, each
 *  a message of its own that can be quoted by its own key. */
export interface ShownMessage extends Sent {
  readonly text: string;
}

export interface ChannelAdapterDeps {
  /** Rome's account on a channel, or null while its record knows none. */
  accountOf(channel: string): Account | null;
  platformOfChannel(channel: string): string;
  /** The channels layer's address store, where a chat the platform reaches
   *  at an id other than its key is reached. */
  addresses?: Pick<
    ChatAddresses,
    "bind" | "addressOf" | "keyAt" | "rekey" | "bindThread" | "threadChatAt"
  >;
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

/** The kind of chat platform address `address` names by itself, before Rome
 *  has heard the chat, or null where the address does not say. On Telegram a
 *  group's id is negative and a person's positive
 *  (https://core.telegram.org/api/bots/ids), and a name says neither; on
 *  WhatsApp a group's JID
 *  ends in `@g.us`. */
export function kindNamedBy(platform: string, address: string): "group" | "dm" | null {
  if (platform === "telegram") {
    // A name such as `@public_channel` may be a channel or a group: it does
    // not say.
    if (/^-[1-9]\d*$/.test(address)) return "group";
    return /^[1-9]\d*$/.test(address) ? "dm" : null;
  }
  if (platform === "whatsapp") return address.endsWith("@g.us") ? "group" : "dm";
  // A Feishu open id names a person, and a chat id a chat of any kind.
  if (platform === "feishu" || platform === "lark") return address.startsWith("ou_") ? "dm" : null;
  return null;
}

/** Which of Rome's accounts holds a message, by the message's key: the account's
 *  platform id, or null for a message no one account holds. */
export type MessageHolder = (messageKey: string) => string | null;

/**
 * Which of Rome's accounts holds each message of the chat keyed `key` on
 * `platform`, or null when the chat does not number its messages per member
 * account. Where it does, each of Rome's accounts there holds its own copy of
 * a message, and only this adapter reads which one from a message's key.
 */
export function messageHolder(platform: string, key: string): MessageHolder | null {
  const chat = chatKey(platform, key as ChatId);
  if (ownedBy(chat, "_", "") === "") return null;
  // Such a chat's message keys carry the holding account in front (ownedBy).
  return (messageKey) => {
    const at = messageKey.indexOf(":");
    return at > 0 ? messageKey.slice(0, at) : null;
  };
}

/** Whether the chat keyed `key` is a direct message, which its key says. */
export function isDirectMessage(key: ChatKey): boolean {
  return otherEndOf(key) !== null;
}

/** The key of the message the platform calls `platformMessageId` in the chat
 *  keyed `chat`, as Rome's account `romeEnd` heard or sent it. */
export function messageKeyAt(chat: ChatKey, romeEnd: string, platformMessageId: string): string {
  return ownedBy(chat, romeEnd, platformMessageId);
}

/** The platform's id for the message keyed `messageKey` in the chat keyed `chat`,
 *  which Rome's account `romeEnd` sent or heard, or null for a message the
 *  platform gave no id or that only another of Rome's accounts holds. */
export function platformIdOfMessage(
  chat: ChatKey,
  romeEnd: string,
  messageKey: string,
): string | null {
  if (messageKey.startsWith("rome:")) return null;
  // Where each account numbers its own messages, a message another account holds
  // has no id this one can quote.
  const owned = ownedBy(chat, romeEnd, "");
  if (owned !== "" && !messageKey.startsWith(owned)) return null;
  return notOwnedBy(chat, romeEnd, messageKey);
}

/**
 * The key a message Rome sent into the chat keyed `chat` through Rome's account
 * `romeEnd` is recorded under: the platform's id for it, or one the adapter
 * gives it when the platform answered none.
 */
export function sentMessageKey(
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
  const account = (): Account => {
    const known = deps.accountOf(channel.name);
    if (!known) throw new ChannelWithoutAccount(channel.name);
    return known;
  };
  // A direct message is the chat the account already reaches at its
  // address, so a reply to a direct message Rome opened by sending to an
  // address lands in that chat even where the key names the address.
  const keyed: ChatKeying = (heardBy, message) => {
    const found = keying(heardBy, message);
    if (!deps.addresses) return found;
    if (found.kind === "group") {
      // A group Rome took for a direct message, as a send opened it, is a
      // group once a group message is heard there, or in one of its threads:
      // the chat moves to its key, or into the group another of Rome's
      // accounts heard there first.
      const bound = deps.addresses.keyAt(heardBy, message.parentChatId ?? message.chatId);
      if (bound !== null && bound !== found.key.externalId) {
        const held = chatKey(heardBy.platform, bound as ChatId);
        if (isDirectMessage(held))
          deps.addresses.rekey(heardBy, bound, found.key.externalId, "group");
      }
      return found;
    }
    if (found.kind !== "dm") return found;
    return {
      key: settledDirectMessage(deps.addresses, heardBy, message.chatId, found.key),
      kind: "dm",
    };
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
      // The message went out either way. A failed write only means the next
      // send opens the conversation by the other end again.
      try {
        deps.addresses?.bind(account(), key.externalId, answered);
      } catch (error) {
        log.warn("could not keep a direct message's address", {
          chat: key.externalId,
          error: String(error),
        });
      }
      return threadId;
    }
    // The platform opened a thread for it, as Discord does for a reply in a
    // channel: keep the thread's chat, so a send there finds it before
    // anything is heard in it.
    try {
      deps.addresses?.bindThread(account(), answered, key.externalId);
    } catch (error) {
      log.warn("could not keep a thread's chat", {
        chat: key.externalId,
        error: String(error),
      });
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
        const inbound = toInbound(channel.name, saved.message.account ?? account(), saved, keyed);
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
        // Stopping lets go of the queue, and a later start may queue the
        // chat afresh.
        if (queues.get(chat) === queue) queues.delete(chat);
      };
      unsubscribe = channel.inbound.subscribe(async (event) => {
        // The port orders each platform address's events and holds the next
        // until this handler returns, but a chat's threads are addresses of
        // their own. So the handler only queues the event on its chat, in the
        // order the port hands it over, and returns: the adapter hands a
        // chat's messages over one at a time, and none waits behind another
        // thread's at the port. The queue is bounded as the port's is.
        // A channel whose record knows no account is not active: what reaches
        // it keys no chat, whatever account the event names.
        const recorded = deps.accountOf(channel.name);
        const heardBy = recorded ? (event.message.account ?? recorded) : null;
        if (!heardBy) {
          log.error("inbound message dropped: channel knows no account", {
            channel: channel.name,
            messageId: event.message.messageId,
          });
          return;
        }
        const chat = keyed(heardBy, event.message).key.externalId;
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
      // What is still waiting was heard for the receiver that stopped, so it
      // is dropped rather than handed to the next one. The message being
      // handed over finishes.
      for (const queue of queues.values()) queue.length = 0;
      queues.clear();
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
      const replyTo = quotable(ref, own.id, out.replyTo);
      const address = addressIn(ref, threadId);
      const receipt = await send.send(address, outgoing(out, replyTo));
      return {
        key: sentMessageKey(ref, own.id, receipt.messageId || undefined),
        threadId: landedIn(ref, address, threadId, receipt.chatId),
      };
    },

    stream(chat, threadId, out) {
      const replies = (channel.send as ChannelSend | undefined)?.replies;
      if (!replies) return null;
      const own = account();
      const ref = chatKey(own.platform, chat as ChatId);
      const replyTo = quotable(ref, own.id, out.replyTo);
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
          // most likely landed, and nothing sends it again. Each part is a
          // message of its own on the platform, so it is one in Chats too,
          // keyed by its own id; one whose create is unknown has no id and
          // takes one of Rome's. A part whose receipt names no chat went where
          // the parts before it went, as the delivery sends each after the last.
          let lastLanded = threadId;
          const shown = outcome.parts.map((part) => {
            if (part.receipt?.chatId)
              lastLanded = landedIn(ref, address, threadId, part.receipt.chatId);
            return {
              text: part.source,
              key: sentMessageKey(ref, own.id, part.receipt?.messageId || undefined),
              threadId: lastLanded,
            };
          });
          return { outcome, shown };
        },
      };
    },
  };
}

/**
 * A channel whose record knows no account. It is not active: it keys no
 * chat, what reaches it is dropped, and a send through it is refused.
 */
export class ChannelWithoutAccount extends Error {
  constructor(readonly channel: string) {
    super(`Channel ${channel} knows no account, so it is not active`);
    this.name = "ChannelWithoutAccount";
  }
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

  /** Rome's account on channel `channel`, as its record knows it. Throws
   *  {@link ChannelWithoutAccount} for a channel that knows none, which is
   *  not active: nothing is keyed by a channel's name. */
  accountOn(channel: string): Account {
    const account = this.deps.accountOf(channel);
    if (!account) throw new ChannelWithoutAccount(channel);
    return account;
  }

  /** Rome's account on channel `channel`, or null while it knows none. */
  knownAccountOn(channel: string): Account | null {
    return this.deps.accountOf(channel);
  }

  /** The platform channel `channel` is on, whether or not it knows its
   *  account. */
  platformOn(channel: string): string {
    return this.deps.platformOfChannel(channel);
  }

  /** The channel Rome's account `account` speaks through, or null when no
   *  channel is that account. The inverse of {@link accountOn}. */
  channelOf(account: Account): string | null {
    return (
      this.deps
        .channelsOn(account.platform)
        .find((channel) => this.knownAccountOn(channel)?.id === account.id) ?? null
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
   * Note that `channel`'s account reaches the direct message keyed `key` at
   * `address`, as one Rome opened there before it knew the other end. The
   * first message from the other end then moves the chat to its key
   * ({@link settledDirectMessage}) rather than starting a second one. An
   * address already kept stays as it is, as does the one kept for the chat,
   * which is where the platform last placed it.
   */
  openedDirectMessageAt(channel: string, address: string, key: ChatKey): void {
    const account = this.accountOn(channel);
    if (this.deps.addresses.keyAt(account, address) !== null) return;
    if (this.deps.addresses.addressOf(account, key.externalId) !== null) return;
    this.deps.addresses.bind(account, key.externalId, address);
  }

  /**
   * The direct message channel `channel`'s account has with `other`, which
   * the channel reaches at `address`. The address is kept, so a send there
   * goes where the channel answered, as for a direct message it heard.
   */
  directMessageReached(channel: string, other: string, address: string): ChatKey {
    const account = this.accountOn(channel);
    const chat = chatAt(account.platform, address, { romeEnd: account.id, other });
    if (address !== other) {
      settledDirectMessage(this.deps.addresses, account, address, chat);
      this.deps.addresses.bind(account, chat.externalId, address);
    }
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

  /** The chat of the thread `channel`'s account heard, or Rome opened, at
   *  platform address `address`, or null when it knows no thread there. */
  threadChatAt(channel: string, address: string): ChatKey | null {
    const account = this.accountOn(channel);
    const key = this.deps.addresses.threadChatAt(account, address);
    return key === null ? null : chatKey(account.platform, key as ChatId);
  }
}

/**
 * The platform's id for the message keyed `messageKey` that account `romeEnd`
 * answers in the chat keyed `chat`, or undefined when it answers none.
 * Refuses a message it has no id for, since the reply would land unquoted.
 */
export function quotable(
  chat: ChatKey,
  romeEnd: string,
  messageKey: string | undefined,
): string | undefined {
  if (messageKey === undefined) return undefined;
  const id = platformIdOfMessage(chat, romeEnd, messageKey);
  if (id === null) {
    throw new SendRefused(
      "reply_unaddressable",
      `Account ${romeEnd} holds no platform id for message ${messageKey}, so it cannot answer it`,
    );
  }
  return id;
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

/**
 * The direct message `account` reaches at `address`, now that its key is
 * known to be `key`. One Rome reached there before it knew the other end is
 * keyed by the address, and takes `key` from here on, so its history stays
 * in the one chat. Another already held there stays the one.
 */
function settledDirectMessage(
  addresses: Pick<ChatAddresses, "keyAt" | "rekey">,
  account: Account,
  address: string,
  key: ChatKey,
): ChatKey {
  const bound = addresses.keyAt(account, address);
  if (bound === null || bound === key.externalId) return key;
  const provisional = chatAt(account.platform, address, { romeEnd: account.id }).externalId;
  if (bound !== provisional) return chatKey(account.platform, bound as ChatId);
  addresses.rekey(account, bound, key.externalId);
  return key;
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
  // Where the address says which it is, it wins over the message's hint: a
  // Telegram account's live message names no kind, so it reads as a group
  // even in a private chat.
  const named = platform === "telegram" ? kindNamedBy(platform, message.chatId) : null;
  if ((named ?? message.thread?.kind) !== "dm")
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
