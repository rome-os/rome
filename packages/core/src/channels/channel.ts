/**
 * A channel as the rest of Rome uses one: its name bound to the four ports that
 * answer for it — sending (`send`), hearing what arrives (`inbound`), who it can
 * reach (`Accounts`, accounts.ts) and what was said to them (`Messages`,
 * messages.ts). So a caller reads one list of channels rather than naming each
 * provider's transport, address book and message store one at a time.
 * Vocabulary: docs/concepts/messaging.md. Invariants:
 * docs/architecture/channels.md#channel-ports.
 *
 * A channel is not a Connection. A Connection may back a channel's `send` and
 * `inbound`, and Rome's own synced tables may back its `accounts` and
 * `messages`, but what backs a port is the channel's business and no caller
 * can tell. The read ports answer with no transport connected: a channel that
 * had to be live to be asked about would make every People read depend on
 * whether the guardian's phone is reachable.
 */

import type {
  ConversationId,
  InboundMessage,
  MessageReceipt,
  OutgoingMessage,
  TalkDirectMessaging,
  TalkInboundMedia,
} from "@rome-os/app-runtime";
import type { AddressBooks } from "./account-fold.js";
import type { Accounts } from "./accounts.js";
import type { Messages } from "./messages.js";

/** Sending on a channel. */
export interface ChannelSend {
  send(conversationId: ConversationId, message: OutgoingMessage): Promise<MessageReceipt>;
  /**
   * Reaching one account directly rather than replying in a conversation that
   * exists, or null (or absent) where the channel cannot. When no Connection
   * exists for the channel, `conversationFor` rejects with
   * {@link ChannelNotConnected}, as `send` does. A Connection that exists but
   * has no live Talk (locked, awaiting re-authorization) reads as null.
   */
  readonly direct?: TalkDirectMessaging | null;
}

/** A send, or a direct-conversation lookup, on a channel nothing backs now. */
export class ChannelNotConnected extends Error {
  constructor(readonly channel: string) {
    super(`No connection backs channel "${channel}"`);
    this.name = "ChannelNotConnected";
  }
}

/**
 * What a subscriber hears from a channel. One kind today; a new kind (an
 * interaction, an edit) joins this union so it passes the same admission as a
 * message, and a handler switching on `kind` keeps compiling.
 */
export type InboundEvent = { kind: "message"; message: InboundMessage };

/**
 * Hearing what arrives on a channel. Every implementation owes all five:
 *
 * - **R1 Admitted only.** The channel's admission runs before any subscriber
 *   hears an event. On a channel that pairs accounts (Telegram, Discord,
 *   Feishu), an account the guardian has not approved never reaches a
 *   subscriber, and neither does a pairing code. Any other channel delivers
 *   every sender, and a subscriber decides what a stranger gets. An admission
 *   that has not decided within fifteen seconds fails closed: that message is
 *   not delivered, and the conversation's next message is admitted in order.
 * - **R2 Answerable only.** An event is something a subscriber may answer: not
 *   Rome's own sends, not the guardian's own messages from another device, not
 *   reactions, edits or frames with no text and no attachments. The complete
 *   record is the channel's `messages`.
 * - **R3 Live, at most once.** Nothing is acknowledged or replayed. An event
 *   that arrives with no subscriber, or while the channel is not receiving, is
 *   not delivered later; a subscriber catches up by reading `messages`.
 * - **R4 Fan-out, ordered per conversation.** Every subscriber hears every
 *   event. A subscriber hears one conversation's events one at a time, in
 *   arrival order: its handler for an event starts after its
 *   handler for the previous event in that conversation settles. Different
 *   conversations and different subscribers never wait on each other, so one
 *   slow or failing handler holds up only its own conversation for its own
 *   subscriber. A handler that never settles stops that conversation for that
 *   subscriber for good, so a subscriber settles every event it takes; one
 *   still running after ten minutes is logged, and so is a conversation with
 *   twenty events waiting. A conversation holds at most a hundred waiting
 *   events per subscriber, and the oldest is dropped and logged past that (R3).
 *   Events still waiting when a subscription ends are dropped (R3); a handler
 *   already running keeps running.
 * - **R5 Durable subscription.** A subscription outlives a reconnect of
 *   whatever backs the channel.
 */
export interface Inbound {
  subscribe(handler: (event: InboundEvent) => Promise<void>): () => void;
  /** Materializes a message's attachments, or null when the channel cannot
   *  now. A consumer without it uses the attachments as delivered. */
  readonly media: TalkInboundMedia | null;
}

/**
 * A channel Rome uses.
 *
 * The two contracts below are the whole of it. Every channel owes both:
 *
 * - **C1 The name is the identity.** One channel per name, one name per
 *   channel, stable for the life of the deployment. It is the `channel` written
 *   on every link, every stored message and every sentinel row, so the name is
 *   not a label a channel can restyle — changing it reassigns history.
 * - **C2 What a channel carries is the channel's.** No port reaches past this
 *   channel's conversations, accounts and messages, so a caller can attribute
 *   anything a port answers to the channel it came from.
 *
 * Channel adds no verb of its own, and every port may be null. A present
 * port is what the channel can do, not a promise it is doing it now: a `send`
 * on a channel nothing currently backs rejects, and an `inbound` subscription
 * taken before anything backs it hears the first event once something does.
 */
export interface Channel {
  /** The channel's name, as every stored row spells it — `whatsapp`,
   *  `linkedin`, `telegram`. */
  readonly name: string;

  /** Sending on the channel, or null where it cannot send at all. */
  readonly send: ChannelSend | null;

  /** What arrives on the channel, or null where nothing ever arrives. */
  readonly inbound: Inbound | null;

  /**
   * The channel's address book, or null where the platform gives Rome no way
   * to enumerate who it reaches.
   *
   * Null is the common case rather than the exceptional one: a channel Rome
   * only receives on knows an address when a message arrives at it and nothing
   * before. A caller that has to show such an account works from the addresses
   * it already holds — a link, a stored message — which is all the channel can
   * say about who it can reach.
   *
   * Null does not say why. A platform that withholds its directory and one
   * whose directory nobody has read yet answer a caller the same.
   */
  readonly accounts: Accounts | null;

  /**
   * What was said on the channel, as the channel can answer for it, or null
   * where it can answer nothing.
   *
   * A channel that holds the conversation as the platform has it answers back
   * past the point Rome started watching. Whether it reads a table a sync fills
   * or calls the platform is its own business, and no caller can tell.
   *
   * Null means what was said there survives only in Rome's own transcript — a
   * store that belongs to no channel and answers for all of them. So not every
   * channel has a store, and not every store is a channel's.
   */
  readonly messages: Messages | null;
}

/**
 * A list of channels, in the order they claim an account. Never every channel
 * there is: channels are open — a Rome App brings its own — so no list
 * enumerates them, and the one Rome reads is `channelList` (channel-list.ts).
 *
 * A channel the list does not hold answers nothing, and so does one holding four
 * null ports. A caller reads either as the answer and works from what it
 * already has, rather than skipping the channel or waiting for a better list.
 *
 * The order is a precedence, and it decides one thing: which channel a caller
 * attributes an address both would answer for. Channels do not overlap by
 * design — an address belongs to the platform that issued it — so a channel
 * ordered behind another is only ever reached for what the one ahead disclaims.
 *
 * Nothing above a list knows how many entries it has or which ports they fill.
 */
export type Channels = readonly Channel[];

/** Each channel's address book by channel name, for the callers that fold every
 *  channel's accounts at once. Channels with no address book are absent, which
 *  is what a fold reads to fall back on the addresses it already holds. */
export function addressBooks(channels: Channels): AddressBooks {
  const books: Record<string, Accounts> = {};
  for (const channel of channels) {
    if (channel.accounts) books[channel.name] = channel.accounts;
  }
  return books;
}

/** The channels' own message stores, in the channels' order. Rome's stores —
 *  the agent transcript, the sentinel log — are not here: they belong to no
 *  channel, and a read that wants them appends them behind these. */
export function messageStores(channels: Channels): Messages[] {
  return channels.flatMap((channel) => (channel.messages ? [channel.messages] : []));
}
