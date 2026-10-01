/**
 * The `send`, `inbound` and `messages` ports of a channel a Connection backs.
 * The channel is named by the service; the Connection that backs it is looked
 * up when a port is used, so a port outlives any one Connection epoch.
 * Contract: `Channel` and `Inbound` (channel.ts), `Messages` (messages.ts).
 */

import type { ChannelMessage, TalkDirectMessaging } from "@rome-os/app-runtime";
import type { InboundMessage, TalkRouter } from "../connections/types.js";
import { historyWindowHours } from "../connections/integrations/talk-features.js";
import type { ConnectionRegistry } from "../connections/registry.js";
import { createLogger } from "../logger.js";
import {
  ChannelNotConnected,
  type ChannelSend,
  type Inbound,
  type InboundEvent,
} from "./channel.js";
import { ConversationBuffers } from "./conversation-buffer.js";
import { MAX_QUERY_LIMIT, queryLimit, type Messages } from "./messages.js";

const log = createLogger("channel-ports");

export interface ConnectionPortsDeps {
  registry: Pick<
    ConnectionRegistry,
    "find" | "getDescriptor" | "onUnlocked" | "registeredServices"
  >;
  /** The router runs the channel's admission (pairing) before a subscriber
   *  hears a message, which is what gives these ports rule R1. */
  router: Pick<TalkRouter, "send" | "subscribe" | "feature">;
}

export interface ConnectionPorts {
  send: ChannelSend | null;
  inbound: Inbound | null;
  messages: Messages | null;
}

/** The ports a service's Talk backs, or null when the service has no Talk. */
export function connectionPorts(
  deps: ConnectionPortsDeps,
  service: string,
): ConnectionPorts | null {
  const talker = deps.registry.getDescriptor(service)?.capabilities.talker;
  if (!talker) return null;
  return {
    send: talker.sends === false ? null : connectionSend(deps, service),
    inbound: talker.receives === false ? null : connectionInbound(deps, service),
    messages: talker.history === true ? connectionMessages(deps, service) : null,
  };
}

/**
 * What was said on a channel with no store of its own, read through its
 * Connection's history. No store answers per-account reads for it, so there is
 * no `byAccount`: a People timeline reads these channels from Rome's own
 * transcript instead.
 *
 * The history answers oldest first, within the Connection's own caps, and
 * reads a window rounded out to whole hours; this port keeps what falls at or
 * after `since` and answers newest first, as every `query` does. The history
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
 * A reused read answers what a fresh one would, older by at most that long.
 * Rome's own `fetch_channel_history` does not read through this port.
 *
 * The port reads the first Connection backing the channel. A channel several
 * Connections back (two Telegram accounts) reads one of them;
 * `ChannelsService.history` and `send` name the one they mean.
 */
export const LIVE_DEFAULT_WINDOW_MS = 24 * 3_600_000;

/** How long a live read is shared among the queries its window covers. */
export const LIVE_READ_TTL_MS = 30_000;

/** One live read, shared while it is fresh. */
interface SharedRead {
  at: number;
  lines: Promise<ChannelMessage[]>;
}

function connectionMessages(deps: ConnectionPortsDeps, service: string): Messages {
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
      const connectionId = connectionIdFor(deps, service);
      if (!connectionId) throw new ChannelNotConnected(service);
      const history = deps.router.feature(connectionId, "history");
      // A Connection whose Talk is not built yet (a credential missing or
      // degraded) backs nothing, the same as no Connection at all.
      if (!history) throw new ChannelNotConnected(service);
      const from = since ?? new Date(Date.now() - LIVE_DEFAULT_WINDOW_MS);
      // The Connection reads whole hours back, so the window it will read
      // names the read along with the conversation.
      const hours = historyWindowHours(from);
      const lines = await read(`${connectionId}\n${conversationId ?? ""}\n${hours}`, () =>
        history.query({
          ...(conversationId ? { conversationId } : {}),
          since: from,
          limit: MAX_QUERY_LIMIT,
        }),
      );
      return lines
        .filter((message) => message.timestamp.getTime() >= from.getTime())
        .reverse()
        .slice(0, queryLimit(limit))
        .map(copyOf);
    },
    byAccount: null,
  };
}

/** A shared read's message, copied for one caller, so a caller that edits what
 *  it was answered (its attachments, say) leaves the others' answers as read.
 *  `raw` stays shared: it is the provider's own, which no caller edits. */
function copyOf(message: ChannelMessage): ChannelMessage {
  return {
    ...message,
    attachments: message.attachments.map((attachment) => ({ ...attachment })),
    ...(message.thread ? { thread: { ...message.thread } } : {}),
  };
}

function connectionIdFor(deps: ConnectionPortsDeps, service: string): string | null {
  return deps.registry.find(service)[0]?.id ?? null;
}

function connectionSend(deps: ConnectionPortsDeps, service: string): ChannelSend {
  // What `direct` answers while no Connection exists for the channel: the
  // lookup itself says so, the way `send` does, rather than passing for a
  // channel that cannot reach an account directly.
  const unbacked: TalkDirectMessaging = {
    conversationFor: () => Promise.reject(new ChannelNotConnected(service)),
  };
  return {
    send(conversationId, message) {
      const connectionId = connectionIdFor(deps, service);
      if (!connectionId) return Promise.reject(new ChannelNotConnected(service));
      return deps.router.send(connectionId, conversationId, message);
    },
    get direct() {
      const connectionId = connectionIdFor(deps, service);
      if (!connectionId) return unbacked;
      return deps.router.feature(connectionId, "directMessaging");
    },
    get activity() {
      const connectionId = connectionIdFor(deps, service);
      return connectionId ? deps.router.feature(connectionId, "activity") : null;
    },
  };
}

/** R2 in the one form every channel shares: nothing to answer. */
function isAnswerable(message: InboundMessage): boolean {
  return Boolean(message.text?.trim()) || message.attachments.length > 0;
}

function connectionInbound(deps: ConnectionPortsDeps, service: string): Inbound {
  // One buffer set per subscription, so two subscriptions of one handler stay
  // two, and each subscription's conversations wait only on themselves (R4).
  const subscriptions = new Set<ConversationBuffers<InboundEvent>>();
  // One router subscription per Connection, fanned out to every handler. The
  // router re-attaches it across that Connection's epochs (R5).
  const attached = new Map<string, () => void>();

  // Each subscription's buffer hears one conversation's events one at a time,
  // in the order they are pushed here, which the router keeps as arrival
  // order (R4). A conversation is keyed by the Connection it arrived on as
  // well, so two Connections' conversations sharing an id never share a queue.
  // Nothing upstream waits on delivery, so dispatch returns once every event
  // is buffered. A subscription's waiting events are dropped when it ends
  // (R3); a handler already running keeps running, and its subscriber owns
  // stopping it.
  const dispatchFrom =
    (connectionId: string) =>
    async (message: InboundMessage): Promise<void> => {
      if (!isAnswerable(message)) return;
      // What a Talk delivers is the record a channel names itself on.
      const event: InboundEvent = {
        kind: "message",
        message: { ...message, channel: service, direction: "inbound" },
        ref: { connectionId, conversationId: message.conversationId },
      };
      // A Connection id is a UUID, so the first colon ends it.
      const conversation = `${connectionId}:${message.conversationId}`;
      for (const buffers of subscriptions) buffers.push(conversation, event);
    };

  const attach = (connectionId: string): void => {
    if (attached.has(connectionId)) return;
    // A removed Connection's subscription goes when its successor attaches.
    const live = new Set(deps.registry.find(service).map((connection) => connection.id));
    for (const [id, detach] of attached) {
      if (live.has(id)) continue;
      detach();
      attached.delete(id);
    }
    attached.set(connectionId, deps.router.subscribe(connectionId, dispatchFrom(connectionId)));
  };

  // A Connection that unlocks after the first subscription still reaches it.
  deps.registry.onUnlocked("talk", (connection) => {
    if (connection.service === service && subscriptions.size > 0) attach(connection.id);
  });

  return {
    subscribe(handler) {
      const subscription = new ConversationBuffers<InboundEvent>(handler, {
        log,
        describe: (event) => ({ channel: service, messageId: event.message.messageId }),
      });
      subscriptions.add(subscription);
      for (const connection of deps.registry.find(service)) attach(connection.id);
      return () => {
        subscriptions.delete(subscription);
        subscription.close();
        if (subscriptions.size > 0) return;
        for (const detach of attached.values()) detach();
        attached.clear();
      };
    },
    get media() {
      const connectionId = connectionIdFor(deps, service);
      return connectionId ? deps.router.feature(connectionId, "inboundMedia") : null;
    },
  };
}
