// A `Messages` store held in memory: the reference the contract suite is
// proved against, and a store any test can state whole. The obligations it
// meets are messages.ts's.

import {
  compareTimelineEntries,
  isAfterTimelineCursor,
  type TimelineEntry,
} from "@rome/api-types/people";
import type { ConversationRead, MessageAccount, MessageRead, Messages } from "./messages.js";

/** One message the store holds, at the address it arrived on and in the
 *  conversation it was said in. */
export interface HeldMessage {
  channel: string;
  address: string;
  /**
   * The conversation, when it is not the address.
   *
   * A direct conversation is addressed by the person on it, so a store that
   * keys a message by who it passed between names both with one string — which
   * is what a message with no conversation of its own says. A store that keys a
   * message by its thread instead names the thread here, the way a LinkedIn
   * message hangs off a thread rather than off a member.
   *
   * A group's messages are held at the group, since that is what addresses one.
   * So no account names them, and the account reads answer none of them without
   * subtracting anything — which is the guarantee messages.ts states.
   */
  conversation?: string;
  entry: TimelineEntry;
}

/**
 * `Messages` over `held`, scoped by the `(channel, address)` pair or by the
 * `(channel, conversation)` one — a string on one channel never selects a
 * message another channel stores under the same string, whichever of the two a
 * read names.
 *
 * A message is answered once however many of the given accounts name its
 * address, because a read filters the list rather than making a pass per
 * address.
 */
export function memoryMessages(held: readonly HeldMessage[]): Messages {
  const ranked = (holds: (message: HeldMessage) => boolean): TimelineEntry[] =>
    held
      .filter(holds)
      .map((message) => message.entry)
      .sort(compareTimelineEntries);

  const full = (accounts: readonly MessageAccount[]): TimelineEntry[] => {
    const scope = new Set(
      accounts.flatMap((account) =>
        account.addresses.map((address) => pair(account.channel, address)),
      ),
    );
    return ranked((message) => scope.has(pair(message.channel, message.address)));
  };

  /** One page off a ranking: what every read here answers, and the only place
   *  the cursor and the limit are applied. */
  const page = (
    entries: TimelineEntry[],
    after: TimelineEntry | null,
    limit: number,
  ): TimelineEntry[] =>
    entries
      .filter((entry) => after === null || isAfterTimelineCursor(entry, after))
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

    async readConversation(request: ConversationRead) {
      const { channel, id } = request.conversation;
      const inConversation = ranked(
        (message) => pair(message.channel, conversationOf(message)) === pair(channel, id),
      );
      return page(inConversation, request.after ?? null, request.limit);
    },
  };
}

/** The conversation a held message was said in — the address it arrived at
 *  unless it names another. */
const conversationOf = (message: HeldMessage) => message.conversation ?? message.address;

const pair = (channel: string, held: string) => `${channel}\n${held}`;
