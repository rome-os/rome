/**
 * The `send`, `inbound`, `messages` and `directory` ports of a channel a
 * Connection backs.
 * A service's channels each have their own name, and the Connection that backs
 * one is looked up by that name when a port is used, so a port outlives any
 * one Connection epoch.
 * Contract: `Channel` (channel.ts), `ChannelInbound` (the apps SDK), `Messages`
 * (messages.ts).
 */

import type {
  ChannelActivity,
  ChannelInbound,
  ChannelInboundMedia,
  ChannelMessage,
  ChatId,
  InboundEvent,
  ChannelDirectMessaging,
  MessageReceipt,
  OutgoingMessage,
} from "@rome-os/app-runtime";
import type { Connection, TalkFeatureName, Talker } from "../connections/types.js";
import { historyWindowHours } from "../connections/integrations/talk-features.js";
import type { ConnectionRegistry } from "../connections/registry.js";
import type { ChannelRecordsRepository } from "../db/repositories/channel-records.js";
import { createLogger } from "../logger.js";
import { type Admission, OrderedAdmission, type OrderedAdmissionOptions } from "./admission.js";
import {
  ChannelNotConnected,
  type ChannelDirectory,
  type ChannelReplies,
  type ChannelSend,
} from "./channel.js";
import { ChatBuffers } from "./conversation-buffer.js";
import type { ConnectionPacing } from "./delivery/connection-pacing.js";
import { DeliveryFailure, type DeliveryTransport } from "./delivery/types.js";
import { MAX_QUERY_LIMIT, queryLimit, type Messages } from "./messages.js";

const log = createLogger("channel-ports");

/** Talk Connections already reported as unlocking with no channel record, so
 *  each is reported once, not once per port of its service. */
const reportedUnrecorded = new Set<string>();

export interface ConnectionPortsDeps {
  registry: Pick<
    ConnectionRegistry,
    "find" | "getDescriptor" | "onUnlocked" | "registeredServices"
  >;
  /** The channel's admission (pairing), run before a subscriber hears a
   *  message, which is what gives these ports rule R1. Absent, every message
   *  is admitted. */
  admit?: Admission;
  admission?: OrderedAdmissionOptions;
  /** Names the channel each Connection backs. A Connection it answers null
   *  for backs no port. */
  channelOf: ChannelOf;
  /** Paces a send while reply streaming is on, and backs the `replies` port. */
  pacing?: ConnectionPacing;
  /** Which channels the inbound port hears. Absent, every channel is heard. */
  listening?: InboundListening;
}

/**
 * Whether a channel's inbound port hears its Connections now. `onChange` tells
 * each port the name of a channel whose answer may have changed, and the port
 * reads `listens` again. A port reads `listens` when a Connection unlocks and
 * on each change, never per message.
 */
export interface InboundListening {
  listens(channel: string): boolean;
  onChange(listener: (channel: string) => void): void;
}

/** The name of the channel a Connection backs, or null when it backs none.
 *  A null matches no channel, so such a Connection backs no port. */
export type ChannelOf = (connection: Pick<Connection, "id" | "service">) => string | null;

/**
 * The channel each Connection backs, as `records` holds it. A Connection of a
 * service with a Talk that has no record backs no channel, rather than its
 * service's first one: it has none while `registry.remove` evicts it after
 * vacating its row, and taking the first channel then would merge it with the
 * Connection that backs that one. A Connection of a service without a Talk
 * backs no recorded channel, and answers its service's name.
 */
export function recordedChannelOf(
  records: Pick<ChannelRecordsRepository, "idOf">,
  talks: (service: string) => boolean,
): ChannelOf {
  return (connection) =>
    records.idOf(connection.id) ?? (talks(connection.service) ? null : connection.service);
}

export interface ConnectionPorts {
  send: ChannelSend | null;
  inbound: ChannelInbound | null;
  messages: Messages | null;
  directory: ChannelDirectory;
}

/**
 * The ports a service's Talk backs for the channel named `channel`, or null
 * when the service has no Talk. `channel` defaults to the service's own name,
 * its first channel.
 *
 * Building the ports subscribes the inbound port to the channel's talkers for
 * the registry's lifetime, while `deps.listening` listens to the channel, and
 * admission runs once per message for each subscription. So build one set per
 * registry and channel, as `channelList` does: a second set would run
 * admission (pairing replies included) twice.
 */
export function connectionPorts(
  deps: ConnectionPortsDeps,
  service: string,
  channel: string = service,
): ConnectionPorts | null {
  const talker = deps.registry.getDescriptor(service)?.capabilities.talker;
  if (!talker) return null;
  const backing: Backing = { deps, service, channel };
  return {
    send: talker.sends === false ? null : connectionSend(backing),
    inbound: talker.receives === false ? null : connectionInbound(backing),
    messages: talker.history === true ? connectionMessages(backing) : null,
    directory: connectionDirectory(backing),
  };
}

/** One channel's ports: the service whose Talk backs them, and the channel's
 *  name, which picks out the Connections behind it. */
interface Backing {
  deps: ConnectionPortsDeps;
  service: string;
  channel: string;
}

/** The Connections backing the channel now, in registry order. */
function connectionsOf(backing: Backing): Connection[] {
  const { deps, service, channel } = backing;
  return deps.registry.find(service).filter((connection) => deps.channelOf(connection) === channel);
}

/**
 * The conversations a channel's Connection can see. A talker says at runtime
 * whether it lists conversations, so the port is present for every channel a
 * Talk backs, and one whose Connection lists none answers empty.
 */
function connectionDirectory(backing: Backing): ChannelDirectory {
  const { service } = backing;
  return {
    async listConversations({ connectionId, ...input }) {
      const connections = connectionsOf(backing).filter(
        (connection) => !connectionId || connection.id === connectionId,
      );
      const listed = await Promise.all(
        connections.map(async (connection) => {
          try {
            const result = await connection.withTalker((talker) =>
              talker.directory?.listConversations(input),
            );
            return result?.conversations ?? [];
          } catch (err) {
            log.warn("channel_directory.failed", {
              connectionId: connection.id,
              service,
              error: err instanceof Error ? err.message : String(err),
            });
            return [];
          }
        }),
      );
      return listed.flat();
    },
  };
}

/**
 * What was said on a channel with no store of its own, read through its
 * Connection's history. No store answers per-account reads for it, so there is
 * no `byAccount`: a People timeline reads these channels from Rome's own
 * transcript instead.
 *
 * The history answers within the Connection's own caps, and reads a window
 * rounded out to whole hours; this port keeps what falls at or after `since`
 * and answers newest first, as every `query` does. It sorts by time rather
 * than trusting the history's order: a read over every conversation
 * (Discord's) orders each conversation's lines but joins the conversations
 * one after another. The history
 * keeps the oldest thousand lines of a window that holds more, so such a
 * window answers the newest of those.
 *
 * A query naming no `since` reads the last {@link LIVE_DEFAULT_WINDOW_MS}. A
 * wider default would not answer newer lines: some platforms' reads (Discord's)
 * keep the oldest lines after their cutoff, so reaching further back trades
 * the newest lines for older ones. A caller wanting more names a `since`.
 *
 * A query is a live platform read, and one naming no conversation is the
 * costly kind: a Telegram account reads its fifty newest chats and fifty lines
 * of each, Discord every channel of every server the bot is in, and email
 * hydrates up to a thousand message bodies. So a read is shared for
 * {@link LIVE_READ_TTL_MS}: a query for the same conversation, or for every
 * conversation, reuses a read already made or under way over the same
 * whole-hour window. Only the same window will do. A Connection cuts what it
 * answers within its window (Discord keeps the oldest hundred lines of each
 * channel), so a wider read can hold none of the lines a narrower one would.
 * A reused read answers what a fresh one would, older by at most that long,
 * and `fetch_channel_history` reads through it like any other caller.
 *
 * The port reads the channel's one Connection. A service may hold several,
 * and each backs a channel of its own.
 */
export const LIVE_DEFAULT_WINDOW_MS = 24 * 3_600_000;

/** How long a live read is shared among the queries its window covers. */
export const LIVE_READ_TTL_MS = 30_000;

/** One live read, shared while it is fresh. */
interface SharedRead {
  at: number;
  lines: Promise<ChannelMessage[]>;
}

function connectionMessages(backing: Backing): Messages {
  const { channel } = backing;
  const shared = new Map<string, SharedRead>();

  /** The read `key` names, shared while it is fresh. */
  function read(key: string, fresh: () => Promise<ChannelMessage[]>): Promise<ChannelMessage[]> {
    const now = Date.now();
    for (const [held, entry] of shared) {
      if (now - entry.at >= LIVE_READ_TTL_MS) shared.delete(held);
    }
    const hit = shared.get(key);
    if (hit) return hit.lines;
    const entry: SharedRead = { at: now, lines: fresh() };
    shared.set(key, entry);
    entry.lines.catch(() => {
      if (shared.get(key) === entry) shared.delete(key);
    });
    return entry.lines;
  }

  return {
    async query({ conversationId, since, limit }) {
      const connection = connectionFor(backing);
      if (!connection) throw new ChannelNotConnected(channel);
      const connectionId = connection.id;
      // A Connection whose talker is not built yet (a credential missing or
      // degraded) backs nothing, the same as no Connection at all.
      if (!connection.withTalker((talker) => talker.history !== undefined)) {
        throw new ChannelNotConnected(channel);
      }
      const from = since ?? new Date(Date.now() - LIVE_DEFAULT_WINDOW_MS);
      // The Connection reads whole hours back, so the window it will read
      // names the read along with the conversation.
      const hours = historyWindowHours(from);
      const lines = await read(
        `${connectionId}\n${conversationId ?? ""}\n${hours}`,
        () =>
          connection.withTalker((talker) =>
            talker.history?.query({
              ...(conversationId ? { conversationId } : {}),
              since: from,
              limit: MAX_QUERY_LIMIT,
            }),
          ) ?? Promise.reject(new ChannelNotConnected(channel)),
      );
      // Reversed before the sort, so lines sharing a timestamp come newest
      // first too.
      return lines
        .filter((message) => message.timestamp.getTime() >= from.getTime())
        .reverse()
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
        .slice(0, queryLimit(limit))
        .map((message) => copyOf(message, channel));
    },
    byAccount: null,
  };
}

/** A shared read's message, copied for one caller, so a caller that edits what
 *  it was answered leaves the others' answers as read: every field, the
 *  timestamp, attachments, thread and reply included. `raw` alone stays
 *  shared: it is the provider's own, which no caller edits. A talker names
 *  its service, so the copy names the channel it was read on. */
function copyOf(message: ChannelMessage, channel: string): ChannelMessage {
  return {
    ...message,
    channel,
    timestamp: new Date(message.timestamp.getTime()),
    attachments: message.attachments.map((attachment) => ({ ...attachment })),
    ...(message.thread ? { thread: { ...message.thread } } : {}),
    ...(message.replyTo ? { replyTo: { ...message.replyTo } } : {}),
  };
}

/** The Connection that backs the channel now. A channel is one presence, so
 *  at most one Connection backs it. */
function connectionFor(backing: Backing): Connection | null {
  return connectionsOf(backing)[0] ?? null;
}

/**
 * Sends on `connection`'s live talker. A Connection whose credentials are
 * locked or degraded has none, and sending on it refuses. With `pacing`, a
 * send waits its turn in the Connection's pacer while reply streaming is on,
 * and resolves once it has run. With streaming off it runs at once.
 */
export async function sendThrough(
  connection: Connection,
  conversationId: ChatId,
  message: OutgoingMessage,
  pacing?: ConnectionPacing,
): Promise<MessageReceipt> {
  const send = async () => {
    const sent = connection.withTalker((talker) => talker.send(conversationId, message));
    if (!sent) throw new Error(`Talk is unavailable for connection "${connection.id}"`);
    return sent;
  };
  return pacing ? pacing.run(connection, conversationId, send) : send();
}

/**
 * The reply port of `connection`, or null when its talker cannot stream. Each
 * write looks the talker up when it runs, so a reply survives a new credential
 * epoch and fails `unauthorized` while talk is locked, rather than writing as a
 * stale epoch.
 */
function connectionReplies(
  connection: Connection,
  pacing: ConnectionPacing,
): ChannelReplies | null {
  const declared = connection.withTalker((talker) => talker.replyDelivery);
  const pacer = pacing.pacerFor(connection);
  if (!declared || !pacer) return null;
  const live = async <T>(write: (transport: DeliveryTransport) => Promise<T> | undefined) => {
    const called = connection.withTalker((talker) =>
      talker.replyDelivery ? write(talker.replyDelivery) : undefined,
    );
    if (!called)
      throw new DeliveryFailure("unauthorized", `${connection.service} is not connected`);
    return called;
  };
  return {
    pacer,
    transport: {
      capabilities: declared.capabilities,
      codec: declared.codec,
      create: (conversation, text, replyTo) =>
        live((transport) => transport.create(conversation, text, replyTo)),
      ...(declared.edit
        ? { edit: (receipt, text) => live((transport) => transport.edit?.(receipt, text)) }
        : {}),
    },
  };
}

/** Whether `connection`'s live talker offers `feature` now. */
function offers(connection: Connection, feature: TalkFeatureName): boolean {
  return connection.withTalker((talker) => talker[feature] !== undefined) ?? false;
}

/** Calls one of `connection`'s talker features as it is when called, which
 *  rejects once the talker no longer offers it. */
async function callTalker<T>(
  connection: Connection,
  call: (talker: Omit<Talker, "start" | "stop">) => Promise<T> | undefined,
): Promise<T> {
  const called = connection.withTalker(call);
  if (!called) throw new ChannelNotConnected(connection.service);
  return called;
}

function connectionSend(backing: Backing): ChannelSend {
  const { channel } = backing;
  // What `direct` answers while no Connection exists for the channel: the
  // lookup itself says so, the way `send` does, rather than passing for a
  // channel that cannot reach an account directly.
  const notConnected = () => Promise.reject(new ChannelNotConnected(channel));
  const unbacked: ChannelDirectMessaging = { chatFor: notConnected, conversationFor: notConnected };
  return {
    async send(conversationId, message) {
      const connection = connectionFor(backing);
      if (!connection) throw new ChannelNotConnected(channel);
      return sendThrough(connection, conversationId, message, backing.deps.pacing);
    },
    get replies() {
      const connection = connectionFor(backing);
      const { pacing } = backing.deps;
      return connection && pacing ? connectionReplies(connection, pacing) : null;
    },
    get direct() {
      const connection = connectionFor(backing);
      if (!connection) return unbacked;
      if (!offers(connection, "directMessaging")) return null;
      const chatFor = (channelUserId: string) =>
        callTalker(connection, (talker) => talker.directMessaging?.chatFor(channelUserId));
      const direct: ChannelDirectMessaging = { chatFor, conversationFor: chatFor };
      return direct;
    },
    get activity() {
      const connection = connectionFor(backing);
      if (!connection || !offers(connection, "activity")) return null;
      const activity: ChannelActivity = {
        begin: (input) => callTalker(connection, (talker) => talker.activity?.begin(input)),
      };
      return activity;
    },
  };
}

/** R2 in the one form every channel shares: nothing to answer. */
function isAnswerable(message: ChannelMessage): boolean {
  return Boolean(message.text?.trim()) || message.attachments.length > 0;
}

function connectionInbound(backing: Backing): ChannelInbound {
  const { deps, channel } = backing;
  // One buffer set per subscription, so two subscriptions of one handler stay
  // two, and each subscription's conversations wait only on themselves (R4).
  const subscriptions = new Set<ChatBuffers<InboundEvent>>();
  // One talker subscription per Connection, fanned out to every handler. A new
  // epoch starts with no handlers, so each unlock subscribes again (R5).
  const attached = new Map<string, () => void>();
  const admission = new OrderedAdmission(deps.admit, deps.admission);

  // Each subscription's buffer hears one conversation's events one at a time,
  // in the order they are pushed here, which admission keeps as arrival
  // order (R4). A conversation is keyed by the Connection it arrived on as
  // well, so two Connections' conversations sharing an id never share a queue.
  // Nothing upstream waits on delivery, so dispatch returns once every event
  // is buffered. A subscription's waiting events are dropped when it ends
  // (R3); a handler already running keeps running, and its subscriber owns
  // stopping it.
  const dispatchFrom =
    (connectionId: string) =>
    async (message: ChannelMessage): Promise<void> => {
      if (!isAnswerable(message)) return;
      // A talker delivers the channel's own record, inbound, named after its
      // service. The event names the channel it arrived on.
      const event: InboundEvent = {
        kind: "message",
        message: message.channel === channel ? message : { ...message, channel },
        ref: { connectionId, conversationId: message.conversationId },
      };
      // A Connection id is a UUID, so the first colon ends it.
      const conversation = `${connectionId}:${message.conversationId}`;
      for (const buffers of subscriptions) buffers.push(conversation, event);
    };

  const listens = (): boolean => deps.listening?.listens(channel) ?? true;

  // Admission runs whether or not anyone subscribes yet: pairing answers a
  // pairing code even before the inbox hears the channel. A channel that is
  // not listened to hears nothing, so not even admission runs: its talker
  // stays up for sending, and what it delivers reaches no handler.
  const attach = (connection: Connection): void => {
    attached.get(connection.id)?.();
    attached.delete(connection.id);
    // A removed Connection's subscription goes when its successor attaches.
    const live = new Set(connectionsOf(backing).map((each) => each.id));
    for (const [id, detach] of attached) {
      if (live.has(id)) continue;
      detach();
      attached.delete(id);
    }
    if (!listens()) return;
    const dispatch = dispatchFrom(connection.id);
    const detach = connection.hearTalker((message) =>
      admission.deliver(connection, message, dispatch),
    );
    if (detach) attached.set(connection.id, detach);
  };

  // Fires now for each Connection already unlocked, then at every unlock.
  deps.registry.onUnlocked("talk", (connection) => {
    if (connection.service !== backing.service) return;
    const named = deps.channelOf(connection);
    if (named === channel) attach(connection);
    // A record is claimed before a Talk Connection first unlocks, so a missing
    // one is a wiring fault, and this Connection's messages go unheard.
    if (named === null && !reportedUnrecorded.has(connection.id)) {
      reportedUnrecorded.add(connection.id);
      log.warn("channel_ports.unrecorded_connection", {
        connectionId: connection.id,
        service: connection.service,
      });
    }
  });

  // A channel starts listening on the Connections unlocked now, and stops by
  // dropping every talker subscription. The subscribers stay, so a channel
  // listened to again reaches the same handlers.
  deps.listening?.onChange((changed) => {
    if (changed !== channel) return;
    if (!listens()) {
      for (const detach of attached.values()) detach();
      attached.clear();
      return;
    }
    for (const connection of connectionsOf(backing)) {
      if (!attached.has(connection.id)) attach(connection);
    }
  });

  return {
    subscribe(handler) {
      const subscription = new ChatBuffers<InboundEvent>(handler, {
        log,
        describe: (event) => ({ channel, messageId: event.message.messageId }),
      });
      subscriptions.add(subscription);
      return () => {
        subscriptions.delete(subscription);
        subscription.close();
      };
    },
    get media() {
      const connection = connectionFor(backing);
      if (!connection || !offers(connection, "inboundMedia")) return null;
      const media: ChannelInboundMedia = {
        materialize: (message) =>
          callTalker(connection, (talker) => talker.inboundMedia?.materialize(message)),
      };
      return media;
    },
  };
}
