/**
 * A channel as the rest of Rome uses one: its name bound to the ports that
 * move messages, sending (`send`) and hearing what arrives (`inbound`), and
 * the chats it can see (`directory`). Who a kind of connection can reach and
 * what was said there are the kind's reads (`ConnectionKind`,
 * connections/connection-kind.ts), not a channel's.
 * Vocabulary: docs/domains/chats.md. Invariants:
 * docs/architecture/channels.md#channel-ports.
 *
 * A channel is not a Connection. A Connection may back a channel's `send` and
 * `inbound`, but what backs a port is the channel's business and no caller
 * can tell. The channel layer is being retired as the domain words replace
 * it (docs/domains/chats.md).
 */

import type {
  Channel as AppChannel,
  ChannelInbound,
  ChannelSend as AppChannelSend,
  ChatDescriptor,
  ChannelDirectMessaging,
} from "@rome-os/app-runtime";
import type { Pacer } from "../../participation/reply-delivery/pacer.js";
import type { DeliveryTransport } from "../../connections/sending.js";

/** Streaming a reply into a chat: the platform's writes, and the pacer
 *  every write of the account goes through. */
export interface AccountReplies {
  readonly transport: DeliveryTransport;
  readonly pacer: Pacer;
}

/** Sending on a channel, as core's channels do it: the SDK's send port, typing
 *  indicator included, and a way to reach one account directly. */
export interface ChannelSend extends AppChannelSend {
  /**
   * Streaming a reply, or null where the channel cannot. It says nothing about
   * whether streaming is on: that is the reply streaming setting, which the
   * caller reads. Each write reaches the Connection's live talker when it
   * runs, and fails `unauthorized` while none is live.
   */
  readonly replies?: AccountReplies | null;
  /**
   * Reaching one account directly rather than replying in a conversation that
   * exists, or null where the channel cannot. When no Connection
   * exists for the channel, `chatFor` rejects with
   * {@link AccountNotConnected}, as `send` does, and so does it while the
   * Connection has no live talker (locked, awaiting re-authorization).
   */
  readonly direct: ChannelDirectMessaging | null;
}

/**
 * The chats an account can see, for chat settings. Each descriptor carries
 * its `ChatRef`, so a caller addresses a chat it found here the way it
 * addresses one an inbound event named.
 */
export interface AccountChats {
  /**
   * Up to `limit` conversations from the Connection backing the channel, or
   * none when `connectionId` names another. A read that fails is logged and
   * answers none.
   */
  listConversations(input: {
    query?: string;
    limit: number;
    includeTopics?: boolean;
    connectionId?: string;
  }): Promise<ChatDescriptor[]>;
}

/** A send, or a direct-message lookup, through one of Rome's accounts that
 *  no connection reaches now. */
export class AccountNotConnected extends Error {
  constructor(readonly channel: string) {
    super(`No connection backs channel "${channel}"`);
    this.name = "AccountNotConnected";
  }
}

/**
 * A channel Rome uses: one of Rome's presences on a platform, such as the
 * `telegram` bot or the `telegram_user` signed-in account. A second presence is
 * a second channel, never a second Connection behind this one.
 *
 * The two contracts below are the whole of it. Every channel owes both:
 *
 * - **C1 The name is the identity.** One channel per name, one name per
 *   channel, stable for the life of the deployment. A channel's name is its
 *   connection kind's, and it is the `channel` written on every link, every stored
 *   message and every sentinel row. The name is not a label a channel can
 *   restyle — changing it reassigns history.
 * - **C2 What a channel carries is the channel's.** No port reaches past this
 *   channel's conversations and messages, so a caller can attribute
 *   anything a port answers to the channel it came from.
 *
 * Channel adds no verb of its own, and every port may be null. A present
 * port is what the channel can do, not a promise it is doing it now: a `send`
 * on a channel nothing currently backs rejects, and an `inbound` subscription
 * taken before anything backs it hears the first event once something does.
 */
export interface Channel extends AppChannel {
  /** The channel's name, as every stored row spells it — `whatsapp`,
   *  `linkedin`, `telegram`. */
  readonly name: string;

  /** Sending on the channel, or null where it cannot send at all. */
  readonly send: ChannelSend | null;

  /** What arrives on the channel, or null where nothing ever arrives. The port
   *  contracts, rules R1–R5 among them, are the apps SDK's: an app hears a
   *  channel through the same `ChannelInbound` core does. */
  readonly inbound: ChannelInbound | null;

  /** The conversations the channel can see, or null where it cannot list
   *  them. */
  readonly directory: AccountChats | null;
}

/**
 * A list of channels, in the order they claim an account. Never every channel
 * there is: channels are open — a Rome App brings its own — so no list
 * enumerates them, and the one Rome reads is `channelList` (channel-list.ts).
 *
 * A channel the list does not hold answers nothing, and so does one holding
 * only null ports. A caller reads either as the answer and works from what it
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

/** The platform a channel's accounts live on, for a caller that holds a
 *  channel's name (`ChannelRecordsRepository.platformOfChannel`). */
export type PlatformOfChannel = (channel: string) => string;

/**
 * The names of the channels whose accounts live on `platform`, in the
 * channels' order: every store an account's history there may sit under, since
 * a message is stored under the channel it arrived on and an account hears
 * from Rome on any of Rome's accounts on its platform.
 */
export function channelsOn(
  channels: Channels,
  platformOfChannel: PlatformOfChannel,
  platform: string,
): string[] {
  return channels
    .filter((channel) => platformOfChannel(channel.name) === platform)
    .map((channel) => channel.name);
}

/** The names of every channel on a platform a record keeps, built or not. */
export type RecordedOn = (platform: string) => readonly string[];

/**
 * Every name an account's history on `platform` may be stored under: the
 * channels built on it, then the recorded ones no longer built. A channel
 * released by a disconnect is not built, but its messages stay in Rome's
 * stores under its name.
 */
export function storedOn(
  channels: Channels,
  platformOfChannel: PlatformOfChannel,
  platform: string,
  recordedOn?: RecordedOn,
): string[] {
  const names = channelsOn(channels, platformOfChannel, platform);
  for (const name of recordedOn?.(platform) ?? []) {
    if (!names.includes(name)) names.push(name);
  }
  return names;
}
