/**
 * The channels Rome uses, built once for every caller that uses all of them.
 * `Channel` (channel.ts) is what one entry is, and a provider joins the
 * address-book fold, the display-name read and a person's history at once by
 * taking an entry here. Vocabulary: docs/concepts/messaging.md.
 */

import type { Connection } from "../connections/types.js";
import type { DrizzleDb } from "../db/index.js";
import type { Accounts } from "./accounts.js";
import type { Channel, Channels } from "./channel.js";
import { type ChannelOf, connectionPorts, type ConnectionPortsDeps } from "./connection-ports.js";
import { linkedInMessages } from "./linkedin-messages.js";
import type { WechatUserReader } from "./wechat-user.js";
import {
  WECHAT_USER_CHANNEL,
  wechatUserAccounts,
  wechatUserMessages,
} from "./wechat-user-messages.js";
import { whatsAppMessages } from "./whatsapp-messages.js";

/**
 * Every channel that can answer something, in the order they claim an account.
 *
 * Partial, and not by omission: channels are open — a Rome App brings its own —
 * so no list enumerates them. A channel that answers nothing holds no entry,
 * which is the same answer as an entry with four null ports.
 *
 * Where an answer comes from is the channel's business. WhatsApp's and
 * LinkedIn's address books and stores read tables a sync fills; every service
 * with a Talk backs its channel's `send` and `inbound` through its Connection,
 * and a Talk that reads the platform's history backs its channel's `messages`.
 * A channel answering the same questions from a live API call implements the
 * same ports and joins the same way.
 *
 * The address books arrive built rather than made here: a channel that folds
 * its whole address book per call serves every caller from one read of it, and
 * two instances of one book is two folds of it.
 *
 * Build it once per registry: each build's inbound ports admit every message
 * the registry's Talks deliver (`connectionPorts`).
 */
export function channelList(deps: {
  db: DrizzleDb;
  whatsAppAccounts: Accounts;
  linkedInAccounts: Accounts;
  /** The personal WeChat reader, present only when that connection is enabled.
   *  It contributes a live store and an address book of the guardian's own
   *  contacts, read straight from the client's database rather than a sync. */
  wechatUserReader?: WechatUserReader;
  /** The Connections that back `send`, `inbound`, `directory` and, where no
   *  store does, `messages`. Every registered service with a Talk contributes a channel;
   *  absent, no channel has those ports. */
  connections?: ConnectionPortsDeps;
  /** Address books for channels a Connection backs, by service. A service
   *  absent here has no address book. */
  connectionAccounts?: Record<string, Accounts>;
  /** The later channels of a service a Connection backs, such as a second
   *  Feishu bot. Each service's first channel is named after it and is built
   *  whether or not anything backs it yet. */
  laterChannels?: ReadonlyArray<{ name: string; service: string }>;
}): Channel[] {
  const reads: Array<Pick<Channel, "name" | "accounts" | "messages">> = [
    { name: "whatsapp", accounts: deps.whatsAppAccounts, messages: whatsAppMessages(deps.db) },
    { name: "linkedin", accounts: deps.linkedInAccounts, messages: linkedInMessages(deps.db) },
    ...(deps.wechatUserReader
      ? [
          {
            name: WECHAT_USER_CHANNEL,
            accounts: wechatUserAccounts(deps.wechatUserReader),
            messages: wechatUserMessages(deps.wechatUserReader),
          },
        ]
      : []),
  ];
  const connections = deps.connections;
  const ports = new Map(
    (connections?.registry.registeredServices() ?? []).flatMap((service) => {
      const backed = connections ? connectionPorts(connections, service) : null;
      return backed ? [[service, backed] as const] : [];
    }),
  );
  const channels: Channel[] = reads.map((read) => ({
    ...read,
    send: ports.get(read.name)?.send ?? null,
    inbound: ports.get(read.name)?.inbound ?? null,
    directory: ports.get(read.name)?.directory ?? null,
  }));
  for (const [name, backed] of ports) {
    if (reads.some((read) => read.name === name)) continue;
    if (!backed.send && !backed.inbound && !backed.messages) continue;
    channels.push({ name, accounts: deps.connectionAccounts?.[name] ?? null, ...backed });
  }
  if (connections) {
    for (const later of deps.laterChannels ?? []) {
      if (channels.some((channel) => channel.name === later.name)) continue;
      const channel = laterChannel(connections, later.service, later.name);
      if (channel) channels.push(channel);
    }
  }
  return channels;
}

/**
 * A later channel of `service`, named `name`, backed by its own Connection.
 * Null when the service has no Talk. It has no address book or store of its
 * own: those a service keeps are its first channel's.
 *
 * Build it once per registry and name, as `channelList` does for the first
 * channel of each service: its inbound port runs admission for every message.
 */
export function laterChannel(
  connections: ConnectionPortsDeps,
  service: string,
  name: string,
): Channel | null {
  const backed = connectionPorts(connections, service, name);
  if (!backed || (!backed.send && !backed.inbound && !backed.messages)) return null;
  return { name, accounts: null, ...backed };
}

/**
 * The channel a Connection backs, added to `channels` when its Talk unlocks
 * and none of them is that channel yet. Null when one already is, or when the
 * service has no Talk, or the Connection backs no channel.
 *
 * Call it from the registry's `onUnlocked("talk")`. The new channel's inbound
 * port registers its own unlock handler while that one is still firing, so the
 * registry hands it this Connection twice. The port keeps one subscription per
 * Connection, so each message still arrives once.
 */
export function joinLaterChannel(
  deps: ConnectionPortsDeps & { channelOf: ChannelOf; channels: Channel[] },
  connection: Pick<Connection, "id" | "service">,
): Channel | null {
  const name = deps.channelOf(connection);
  if (name === null || deps.channels.some((channel) => channel.name === name)) return null;
  const channel = laterChannel(deps, connection.service, name);
  if (channel) deps.channels.push(channel);
  return channel;
}
