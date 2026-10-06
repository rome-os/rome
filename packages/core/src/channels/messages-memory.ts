// An `AccountMessages` store held in memory: the reference the contract suite is
// proved against, and a store any test can state whole. The obligations it
// meets are messages.ts's.

import { compareMessages, isAfterMessageCursor, type Message } from "@rome/api-types/message";
import type { AccountMessages, MessageAccount, MessageRead } from "./messages.js";

/** One message the store holds, at the address it arrived on. A group's
 *  messages are held at the group, since that is what addresses one, so no
 *  account names them — the guarantee messages.ts states. */
export interface HeldMessage {
  channel: string;
  address: string;
  entry: Message;
}

/**
 * `AccountMessages` over `held`, scoped by the `(channel, address)` pair — a
 * string on one channel never selects a message another channel stores under
 * the same string.
 *
 * A message is answered once however many of the given accounts name its
 * address, because a read filters the list rather than making a pass per
 * address.
 */
export function memoryMessages(held: readonly HeldMessage[]): AccountMessages {
  const ranked = (holds: (message: HeldMessage) => boolean): Message[] =>
    held
      .filter(holds)
      .map((message) => message.entry)
      .sort(compareMessages);

  const full = (accounts: readonly MessageAccount[]): Message[] => {
    const scope = new Set(
      accounts.flatMap((account) =>
        account.addresses.map((address) => pair(account.channel, address)),
      ),
    );
    return ranked((message) => scope.has(pair(message.channel, message.address)));
  };

  /** One page off a ranking: what every read here answers, and the only place
   *  the cursor and the limit are applied. */
  const page = (entries: Message[], after: Message | null, limit: number): Message[] =>
    entries
      .filter((entry) => after === null || isAfterMessageCursor(entry, after))
      .slice(0, Math.max(1, Math.floor(limit)));

  return {
    async read(request: MessageRead) {
      return page(full(request.accounts), request.after ?? null, request.limit);
    },

    async count(accounts) {
      return full(accounts).length;
    },

    async latest(accounts) {
      return full(accounts)[0] ?? null;
    },
  };
}

const pair = (channel: string, held: string) => `${channel}\n${held}`;
