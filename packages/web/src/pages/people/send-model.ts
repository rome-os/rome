import { accountRef, formatWhatsAppPhone, type LinkedAccount } from "@rome/api-types/people";
import type { Message } from "@rome/api-types/message";

// The shape of the person page's two views, with no React in it: which segments
// the switcher offers, and what each one scopes.
//
// The segments are per account, not per channel. For almost everyone the two
// are the same thing and a segment reads as a channel; for a person holding two
// numbers on one channel it is the difference between a composer that knows
// where it is going and one that does not — and that person is exactly who the
// contract refuses to guess for.
//
// Which account a send names is `defaultSendAccount` in the contract, not here.
// A second answer to "who receives this" is the one thing this surface must not
// have.

/** The merged segment's value. Not an account ref, which always carries a colon
 *  ({@link accountRef}), so no account can collide with it. */
export const ALL_ACCOUNTS = "all";

/** One segment of the switcher: an account, and how to tell it from its
 *  neighbours. */
export interface AccountSegment {
  /** {@link accountRef} of the account — the segment's value and its key. */
  value: string;
  account: LinkedAccount;
  /**
   * The handle to label this segment with, or null to label it with the
   * channel's own name.
   *
   * Set only where the channel name would not tell two segments apart: a person
   * holding two WhatsApp numbers would otherwise get two segments both saying
   * "WhatsApp", and picking one would be picking blind.
   */
  handle: string | null;
}

/**
 * The identifier a guardian recognizes an account by.
 *
 * A WhatsApp jid renders as the phone number it carries, and an agent as its
 * label, since its address is an opaque Cloud id no UI shows. Every other
 * channel shows the address it minted, which is what its own UI shows. The
 * People list's `rowHandle` applies the same rule, so a reader recognizes the
 * same account by the same string on both surfaces.
 */
export function accountHandle(account: {
  channel: string;
  channelUserId: string;
  displayName: string;
}): string {
  if (account.channel === "agents") return account.displayName;
  return account.channel === "whatsapp"
    ? (formatWhatsAppPhone(account.channelUserId) ?? account.channelUserId)
    : account.channelUserId;
}

/** One segment per account, in the order the person read listed them. */
export function accountSegments(accounts: readonly LinkedAccount[]): AccountSegment[] {
  return accounts.map((account) => {
    const sameChannel = accounts.filter((other) => other.channel === account.channel);
    return {
      value: accountRef(account),
      account,
      handle: sameChannel.length > 1 ? accountHandle(account) : null,
    };
  });
}

/** The account a segment names, or null on the merged segment. */
export function segmentAccount(
  segments: readonly AccountSegment[],
  value: string,
): LinkedAccount | null {
  return segments.find((segment) => segment.value === value)?.account ?? null;
}

/**
 * The timeline a segment shows: everything on the merged segment, and one
 * channel's entries inside an account segment.
 *
 * By channel, because that is all an entry names. A person with two numbers on
 * one channel sees both accounts' history under either of their segments, which
 * is the honest answer — the contract is explicit that a timeline entry carries
 * no address to narrow by, and inventing one here is the guess the composer
 * refuses to make.
 */
export function segmentEntries(
  entries: readonly Message[],
  account: LinkedAccount | null,
): Message[] {
  return account ? entries.filter((entry) => entry.source === account.channel) : [...entries];
}

/** The pending sends a segment shows. Narrowed by the account itself, which a
 *  send does name. */
export function segmentSends<T extends { channel: string; channelUserId: string }>(
  sends: readonly T[],
  account: LinkedAccount | null,
): T[] {
  return account
    ? sends.filter(
        (send) => send.channel === account.channel && send.channelUserId === account.channelUserId,
      )
    : [...sends];
}
