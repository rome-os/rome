// An account as the People contract (@rome/api-types/people) still spells it:
// a channel and an address. People keys a link by the `Account` value, the
// platform and the platform's own id (docs/domains/chats.md#account), and the
// wire's `channel` carries the platform. These two are the one place the two
// spellings meet, so nothing past the route reads a channel off a link.

import type { Account } from "@rome-os/app-runtime";
import { platformOf } from "@rome/api-types/platform";

/** An account as the wire names it. */
export interface WireAccount {
  channel: string;
  channelUserId: string;
}

/**
 * The account a wire pair names. A client written before links named a
 * platform may still send the kind of connection, such as `telegram_user`,
 * and that reads as its platform. A Lark sender sent as `feishu` cannot be
 * told apart from a Feishu one, so it reads as Feishu.
 */
export function accountOfWire(wire: WireAccount): Account {
  return { platform: platformOf(wire.channel), id: wire.channelUserId };
}

/** An account as the wire names it. */
export function wireOf(account: Account): WireAccount {
  return { channel: account.platform, channelUserId: account.id };
}
