/**
 * The `send` and `inbound` ports of a channel a Connection backs. The channel
 * is named by the service; the Connection that backs it is looked up when a
 * port is used, so a port outlives any one Connection epoch.
 * Contract: `Channel` and `Inbound` (channel.ts).
 */

import type { InboundMessage, TalkDirectMessaging, TalkRouter } from "@rome-os/app-runtime";
import type { ConnectionRegistry } from "../connections/registry.js";
import { createLogger } from "../logger.js";
import {
  ChannelNotConnected,
  type ChannelSend,
  type Inbound,
  type InboundEvent,
} from "./channel.js";
import { ConversationBuffers } from "./conversation-buffer.js";

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
  };
}

function connectionIdFor(deps: ConnectionPortsDeps, service: string): string | null {
  return deps.registry.find(service)[0]?.id ?? null;
}

function connectionSend(deps: ConnectionPortsDeps, service: string): ChannelSend {
  // What `direct` answers while nothing backs the channel: the lookup itself
  // says so, the way `send` does, rather than passing for a channel that
  // cannot reach an account directly.
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
  // order (R4). Nothing upstream waits on delivery, so dispatch returns once
  // every event is buffered. A subscription's waiting events are dropped when
  // it ends (R3); a handler already running keeps running, and its subscriber
  // owns stopping it.
  const dispatch = async (message: InboundMessage): Promise<void> => {
    if (!isAnswerable(message)) return;
    const event: InboundEvent = { kind: "message", message };
    for (const buffers of subscriptions) buffers.push(message.conversationId, event);
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
    attached.set(connectionId, deps.router.subscribe(connectionId, dispatch));
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
