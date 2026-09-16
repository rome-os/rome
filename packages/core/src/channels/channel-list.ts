/**
 * The channels Rome reads, built once for every caller that reads all of them.
 * `Channel` (channel.ts) is what one entry is, and a provider joins the
 * address-book fold, the display-name read and a person's history at once by
 * taking an entry here. Vocabulary: docs/concepts/messaging.md.
 */

import type { DrizzleDb } from "../db/index.js";
import type { Accounts } from "./accounts.js";
import type { Channels } from "./channel.js";
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
 * so no list enumerates them. A channel that answers neither question holds no
 * entry, which is the same answer as an entry with two null ports.
 *
 * Where an answer comes from is the channel's business. These two read tables a
 * sync fills, and a channel answering the same questions from a live API call
 * implements the same ports and joins the same way.
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
}): Channels {
  return [
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
}
