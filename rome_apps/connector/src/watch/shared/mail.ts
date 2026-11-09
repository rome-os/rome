// What every mail source shares: whether a sender is a person, the addresses
// in a header, bulk precedence, and the options a mail follow can state.

import type { WatchOption } from "../types.js";

/**
 * Senders no person answers from: a no-reply, notification, bounce or
 * mailer token anywhere in the address's local part, as a whole token between
 * `.`, `_`, `+` or `-` (`jobalerts-noreply@`, `noreply.billing@`), so a name
 * that only contains those letters (`noriko@`, `bouncer.lee@`) is a person.
 */
export function isAutomatedSender(address: string): boolean {
  const local = address.split("@")[0]?.toLowerCase() ?? "";
  return /(^|[._+-])(no-?reply|do-?not-?reply|notifications?|notify|mailer-daemon|postmaster|bounces?)($|[._+-])/.test(
    local,
  );
}
export const BULK_PRECEDENCE = /^(bulk|list|junk)$/i;

/** The bare addresses in a header such as `Ana <ana@x.io>, bo@y.io`, lower-cased. */
export function addressesIn(value: string | undefined): string[] {
  if (!value) return [];
  return [...value.matchAll(/[^\s<>,;"']+@[^\s<>,;"']+/g)].map((match) => match[0].toLowerCase());
}

/** The options a mail follow can state, the same for every mailbox. */
export const MAIL_OPTIONS: WatchOption[] = [
  {
    key: "recipients",
    label: "Mail sent to",
    type: "enum",
    values: [
      { value: "to_and_cc", label: "Me, or with me in cc" },
      { value: "to", label: "Me directly" },
    ],
    default: "to_and_cc",
  },
  {
    key: "vipSenders",
    label: "Always tell me about these senders",
    type: "list",
    default: [],
    itemHint: "Addresses or domains",
  },
];
