import type { Account } from "./accounts.js";

/**
 * The in-memory half of `Accounts.listAccounts`, for channels that mirror
 * the whole address book locally and page over it here. A channel whose
 * provider paginates server-side pages there and does not use this.
 */

/** Case-insensitive substring match over the name and every identifier value.
 *  An account the platform holds no name for is still found by any identifier
 *  it carries. */
function matches(account: Account, needle: string): boolean {
  if (account.name != null && account.name.toLowerCase().includes(needle)) return true;
  for (const value of Object.values(account.identifiers)) {
    if (value.toLowerCase().includes(needle)) return true;
  }
  return false;
}

// Page size used when a caller passes a limit that is not a number at all. A
// route that builds one from a query string can produce NaN, and answering that
// with an empty page would be indistinguishable from an exhausted listing.
const FALLBACK_LIMIT = 50;

/**
 * One page of an already-ordered account list. The cursor is an offset into the
 * filtered list — opaque to the caller, and rejected back to the first page
 * when it does not parse, so a corrupt value cannot walk off the end silently.
 *
 * Offset paging assumes the listing holds still. It does not: a WhatsApp
 * account moves to the front when a message arrives, so an inbound message
 * between two pages shifts every later account down and one of them is skipped
 * or repeated. A caller that needs every account exactly once reads the whole
 * listing in one page rather than walking cursors across a live mirror.
 */
export function pageAccounts(
  accounts: Account[],
  input: { query?: string; cursor?: string; limit: number },
): { accounts: Account[]; nextCursor?: string } {
  const needle = input.query?.trim().toLowerCase();
  const filtered = needle ? accounts.filter((a) => matches(a, needle)) : accounts;

  const parsed = input.cursor == null ? 0 : Number(input.cursor);
  const start = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
  const limit = Number.isFinite(input.limit)
    ? Math.max(1, Math.floor(input.limit))
    : FALLBACK_LIMIT;
  const end = start + limit;

  return {
    accounts: filtered.slice(start, end),
    nextCursor: end < filtered.length ? String(end) : undefined,
  };
}
