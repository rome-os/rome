/**
 * The channels Rome uses, built once for every caller that uses all of them.
 * `Channel` (channel.ts) is what one entry is, and a provider joins the
 * send and inbound paths at once by taking an entry here. Vocabulary:
 * docs/domains/chats.md.
 */

import type { Connection } from "../../connections/types.js";
import type { ConnectionKinds } from "../../connections/connection-kind.js";
import type { Channel, Channels } from "./connected-account.js";
import { type ChannelOf, connectionPorts, type ConnectionPortsDeps } from "./connection-ports.js";

/**
 * Every channel that can send or hear, in the order they claim an account.
 *
 * Partial, and not by omission: channels are open — a Rome App brings its own —
 * so no list enumerates them. A channel that answers nothing holds no entry,
 * which is the same answer as an entry with only null ports.
 *
 * Every kind of connection with a Talk backs its channel's `send` and
 * `inbound` through its Connection. Each kind that holds a history
 * (`ConnectionKind.messages`) keeps a channel named after it whether or not
 * anything backs it, so its name stays among the names an account's history
 * on its platform is read under (`storedOn`).
 *
 * Build it once per registry: each build's inbound ports admit every message
 * the registry's Talks deliver (`connectionPorts`).
 */
export function channelList(deps: {
  /** The kinds that answer a read. Each one that holds a history keeps a
   *  channel. */
  kinds?: ConnectionKinds;
  /** The Connections that back `send`, `inbound` and `directory`. Every
   *  registered connection kind with a Talk contributes a channel; absent, no
   *  channel has those ports. */
  connections?: ConnectionPortsDeps;
  /** The later channels of a connection kind a Connection backs, such as a second
   *  Feishu bot. Each connection kind's first channel is named after it and is built
   *  whether or not anything backs it yet. */
  laterChannels?: ReadonlyArray<{ name: string; connectionKind: string }>;
  /** Channels Rome serves itself, which no Connection backs, such as webchat. */
  own?: readonly Channel[];
}): Channel[] {
  const connections = deps.connections;
  const ports = new Map(
    (connections?.registry.registeredKinds() ?? []).flatMap((connectionKind) => {
      const backed = connections ? connectionPorts(connections, connectionKind) : null;
      return backed ? [[connectionKind, backed] as const] : [];
    }),
  );
  const own = deps.own ?? [];
  const reading = (deps.kinds ?? []).filter(
    (kind) => kind.messages !== null && !own.some((channel) => channel.name === kind.name),
  );
  const channels: Channel[] = reading.map(({ name }) => ({
    name,
    send: ports.get(name)?.send ?? null,
    inbound: ports.get(name)?.inbound ?? null,
    directory: ports.get(name)?.directory ?? null,
  }));
  channels.push(...own);
  for (const [name, backed] of ports) {
    if (reading.some((kind) => kind.name === name)) continue;
    if (!backed.send && !backed.inbound) continue;
    channels.push({ name, ...backed });
  }
  if (connections) {
    for (const later of deps.laterChannels ?? []) {
      if (channels.some((channel) => channel.name === later.name)) continue;
      const channel = laterChannel(connections, later.connectionKind, later.name);
      if (channel) channels.push(channel);
    }
  }
  return channels;
}

/**
 * A later channel of `connectionKind`, named `name`, backed by its own Connection.
 * Null when the connection kind has no Talk. Its kind's address book and
 * history are the kind's (`ConnectionKind`), not this channel's.
 *
 * Build it once per registry and name, as `channelList` does for the first
 * channel of each connection kind: its inbound port runs admission for every message.
 */
export function laterChannel(
  connections: ConnectionPortsDeps,
  connectionKind: string,
  name: string,
): Channel | null {
  const backed = connectionPorts(connections, connectionKind, name);
  if (!backed || (!backed.send && !backed.inbound)) return null;
  return { name, ...backed };
}

/**
 * The channel a Connection backs, added to `channels` when its chat unlocks
 * and none of them is that channel yet. Null when one already is, or when the
 * connection kind has no Talk, or the Connection backs no channel.
 *
 * Call it from the registry's `onUnlocked("chat")`. The new channel's inbound
 * port registers its own unlock handler while that one is still firing, so the
 * registry hands it this Connection twice. The port keeps one subscription per
 * Connection, so each message still arrives once.
 */
export function joinLaterChannel(
  deps: ConnectionPortsDeps & { channelOf: ChannelOf; channels: Channel[] },
  connection: Pick<Connection, "id" | "connectionKind">,
): Channel | null {
  const name = deps.channelOf(connection);
  if (name === null || deps.channels.some((channel) => channel.name === name)) return null;
  const channel = laterChannel(deps, connection.connectionKind, name);
  if (channel) deps.channels.push(channel);
  return channel;
}
