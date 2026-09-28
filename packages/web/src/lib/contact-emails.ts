import type { DirectoryAccount } from "@rome/api-types/people";
import { parseEmailTextarea } from "@/lib/email-list";

/** One contact email offered while typing an access allow-list. */
export interface ContactEmailSuggestion {
  email: string;
  /** Who the address belongs to, or null when the only name on record is the
   *  address itself. */
  name: string | null;
}

/** The channel whose accounts are keyed by email address. */
const EMAIL_CHANNEL = "email";

/**
 * The email addresses in a page of the contacts list, in the page's order,
 * ready to offer as completions.
 *
 * Only the email channel's accounts count. Other channels' ids can pass an
 * email pattern without being one — a WhatsApp JID is `<phone>@s.whatsapp.net`.
 * An address with a colon is a namespaced id (`unauthenticated:…`), not one a
 * visitor signs in with. Dismissed accounts are left out, because the guardian
 * has said they are nobody to them.
 */
export function contactEmailSuggestions(
  accounts: readonly DirectoryAccount[],
  options: { exclude?: Iterable<string>; limit?: number } = {},
): ContactEmailSuggestion[] {
  const limit = options.limit ?? 6;
  const seen = new Set(options.exclude ?? []);
  const suggestions: ContactEmailSuggestion[] = [];

  for (const account of accounts) {
    if (account.channel !== EMAIL_CHANNEL || account.state === "dismissed") continue;
    for (const address of account.addresses) {
      if (address.includes(":")) continue;
      const [email] = parseEmailTextarea(address).emails;
      if (!email || seen.has(email)) continue;
      seen.add(email);
      const name = account.personName ?? account.displayName;
      suggestions.push({ email, name: name.trim().toLowerCase() === email ? null : name });
      if (suggestions.length >= limit) return suggestions;
    }
  }
  return suggestions;
}
