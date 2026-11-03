/**
 * The `send`, `inbound` and `directory` ports of a channel a Connection
 * backs.
 * A connection kind's channels each have their own name, and the Connection that backs
 * one is looked up by that name when a port is used, so a port outlives any
 * one Connection epoch.
 * Contract: `Channel` (channel.ts), `ChannelInbound` (the apps SDK).
 */

import type {
  Account,
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

const log = createLogger("channel-ports");

/** Talk Connections already reported as unlocking with no channel record, so
 *  each is reported once, not once per port of its connection kind. */
const reportedUnrecorded = new Set<string>();

export interface ConnectionPortsDeps {
  registry: Pick<ConnectionRegistry, "find" | "getDescriptor" | "onUnlocked" | "registeredKinds">;
  /** The channel's admission, run before a subscriber hears a
   *  message, which is what gives these ports rule R1. Absent, every message
   *  is admitted. */
  admit?: Admission;
  admission?: OrderedAdmissionOptions;
  /** Names the channel each Connection backs. A Connection it answers null
   *  for backs no port. */
  channelOf: ChannelOf;
  /** Paces a send while reply streaming is on, and backs the `replies` port. */
  pacing?: ConnectionPacing;
  /** Which Connections the inbound port hears. Absent, every one is heard. */
  listening?: InboundListening;
  /** The account each Connection reaches, which an inbound message names as
   *  the one it arrived on. Absent, or null for a Connection, a message names
   *  none. */
  accountOf?: (connectionId: string) => Account | null;
  /** Hears each inbound message an admitted sender sends, before anything
   *  else does, so what the sender called themselves reaches the account
   *  profile cache (account-profiles.ts). Must not throw. */
  heard?: (message: ChannelMessage) => void;
}

/**
 * Whether an inbound port hears a Connection now, by its id. `onChange` tells
 * each port the id of a Connection whose answer may have changed, and the port
 * reads `listens` again. A port reads `listens` when a Connection unlocks and
 * on each change, never per message.
 */
export interface InboundListening {
  listens(connectionId: string): boolean;
  onChange(listener: (connectionId: string) => void): void;
}

/** The name of the channel a Connection backs, or null when it backs none.
 *  A null matches no channel, so such a Connection backs no port. */
export type ChannelOf = (connection: Pick<Connection, "id" | "connectionKind">) => string | null;

/**
 * The channel each Connection backs, as `records` holds it. A Connection of a
 * connection kind with a Talk that has no record backs no channel, rather than its
 * connection kind's first one: it has none while `registry.remove` evicts it after
 * vacating its row, and taking the first channel then would merge it with the
 * Connection that backs that one. A Connection of a connection kind without a Talk
 * backs no recorded channel, and answers its connection kind's name.
 */
export function recordedChannelOf(
  records: Pick<ChannelRecordsRepository, "idOf">,
  talks: (connectionKind: string) => boolean,
): ChannelOf {
  return (connection) =>
    records.idOf(connection.id) ??
    (talks(connection.connectionKind) ? null : connection.connectionKind);
}

export interface ConnectionPorts {
  send: ChannelSend | null;
  inbound: ChannelInbound | null;
  directory: ChannelDirectory;
}

/**
 * The ports a connection kind's Talk backs for the channel named `channel`, or null
 * when the connection kind has no Talk. `channel` defaults to the connection kind's own name,
 * its first channel.
 *
 * Building the ports subscribes the inbound port to the channel's talkers for
 * the registry's lifetime, while `deps.listening` hears each Connection, and
 * admission runs once per message for each subscription. So build one set per
 * registry and channel, as `channelList` does: a second set would run
 * admission twice.
 */
export function connectionPorts(
  deps: ConnectionPortsDeps,
  connectionKind: string,
  channel: string = connectionKind,
): ConnectionPorts | null {
  const talker = deps.registry.getDescriptor(connectionKind)?.capabilities.talker;
  if (!talker) return null;
  const backing: Backing = { deps, connectionKind, channel };
  return {
    send: talker.sends === false ? null : connectionSend(backing),
    inbound: talker.receives === false ? null : connectionInbound(backing),
    directory: connectionDirectory(backing),
  };
}

/** One channel's ports: the connection kind whose Talk backs them, and the channel's
 *  name, which picks out the Connections behind it. */
interface Backing {
  deps: ConnectionPortsDeps;
  connectionKind: string;
  channel: string;
}

/** The Connections backing the channel now, in registry order. */
function connectionsOf(backing: Backing): Connection[] {
  const { deps, connectionKind, channel } = backing;
  return deps.registry
    .find(connectionKind)
    .filter((connection) => deps.channelOf(connection) === channel);
}

/**
 * The conversations a channel's Connection can see. A talker says at runtime
 * whether it lists conversations, so the port is present for every channel a
 * Talk backs, and one whose Connection lists none answers empty.
 */
function connectionDirectory(backing: Backing): ChannelDirectory {
  const { connectionKind } = backing;
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
              connectionKind,
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
  chatId: ChatId,
  message: OutgoingMessage,
  pacing?: ConnectionPacing,
): Promise<MessageReceipt> {
  const send = async () => {
    const sent = connection.withTalker((talker) => talker.send(chatId, message));
    if (!sent) throw new Error(`Talk is unavailable for connection "${connection.id}"`);
    return sent;
  };
  return pacing ? pacing.run(connection, chatId, send) : send();
}

/**
 * The reply port of `connection`, or null when its talker cannot stream. Each
 * write looks the talker up when it runs, so a reply survives a new credential
 * epoch and fails `unauthorized` while chat is locked, rather than writing as a
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
      throw new DeliveryFailure("unauthorized", `${connection.connectionKind} is not connected`);
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
      ...(declared.settle
        ? { settle: (receipt, text) => live((transport) => transport.settle?.(receipt, text)) }
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
  if (!called) throw new ChannelNotConnected(connection.connectionKind);
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
    async send(chatId, message) {
      const connection = connectionFor(backing);
      if (!connection) throw new ChannelNotConnected(channel);
      return sendThrough(connection, chatId, message, backing.deps.pacing);
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
      // A talker delivers the channel's own record, inbound, named after its
      // connection kind. The event names the channel and the account it
      // arrived on.
      const account = deps.accountOf?.(connectionId) ?? null;
      const named: ChannelMessage = { ...message, channel, ...(account ? { account } : {}) };
      // A message with nothing to answer still says who sent it.
      deps.heard?.(named);
      if (!isAnswerable(message)) return;
      const event: InboundEvent = {
        kind: "message",
        message: named,
        ref: { connectionId, chatId: message.chatId },
      };
      // A Connection id is a UUID, so the first colon ends it.
      const conversation = `${connectionId}:${message.chatId}`;
      for (const buffers of subscriptions) buffers.push(conversation, event);
    };

  const listens = (connection: Connection): boolean =>
    deps.listening?.listens(connection.id) ?? true;

  // Admission runs whether or not anyone subscribes yet: the Agents channel
  // links an agent to the guardian even before the inbox hears it. A channel that is
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
    if (!listens(connection)) return;
    const dispatch = dispatchFrom(connection.id);
    const detach = connection.hearTalker((message) =>
      admission.deliver(connection, message, dispatch),
    );
    if (detach) attached.set(connection.id, detach);
  };

  // Fires now for each Connection already unlocked, then at every unlock.
  deps.registry.onUnlocked("chat", (connection) => {
    if (connection.connectionKind !== backing.connectionKind) return;
    const named = deps.channelOf(connection);
    if (named === channel) attach(connection);
    // A record is claimed before a Talk Connection first unlocks, so a missing
    // one is a wiring fault, and this Connection's messages go unheard.
    if (named === null && !reportedUnrecorded.has(connection.id)) {
      reportedUnrecorded.add(connection.id);
      log.warn("channel_ports.unrecorded_connection", {
        connectionId: connection.id,
        connectionKind: connection.connectionKind,
      });
    }
  });

  // A Connection starts being heard once unlocked, and stops by dropping its
  // talker subscription. The subscribers stay, so a Connection heard again
  // reaches the same handlers.
  deps.listening?.onChange((changed) => {
    const connection = connectionsOf(backing).find((each) => each.id === changed);
    if (!connection) return;
    if (!listens(connection)) {
      attached.get(connection.id)?.();
      attached.delete(connection.id);
      return;
    }
    if (!attached.has(connection.id)) attach(connection);
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
