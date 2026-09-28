/**
 * The channels Rome uses, built once for every caller that uses all of them.
 * `Channel` (channel.ts) is what one entry is, and a provider joins the
 * address-book fold, the display-name read and a person's history at once by
 * taking an entry here. Vocabulary: docs/concepts/messaging.md.
 */

import type { DrizzleDb } from "../db/index.js";
import type { Accounts } from "./accounts.js";
import type { Channel, Channels } from "./channel.js";
import { connectionPorts, type ConnectionPortsDeps } from "./connection-ports.js";
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
 * with a Talk backs its channel's `send` and `inbound` through its Connection.
 * A channel answering the same questions from a live API call implements the
 * same ports and joins the same way.
 *
 * The address books arrive built rather than made here: a channel that folds
 * its whole address book per call serves every caller from one read of it, and
 * two instances of one book is two folds of it.
 */
export function channelList(deps: {
  db: DrizzleDb;
  whatsAppAccounts: Accounts;
  linkedInAccounts: Accounts;
  /** The personal WeChat reader, present only when that connection is enabled.
   *  It contributes a live store and an address book of the guardian's own
   *  contacts, read straight from the client's database rather than a sync. */
  wechatUserReader?: WechatUserReader;
  /** The Connections that back `send` and `inbound`. Every registered service
   *  with a Talk contributes a channel; absent, no channel has either port. */
  connections?: ConnectionPortsDeps;
}): Channels {
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
  }));
  for (const [name, backed] of ports) {
    if (reads.some((read) => read.name === name) || (!backed.send && !backed.inbound)) continue;
    channels.push({ name, accounts: null, messages: null, ...backed });
  }
  return channels;
}
