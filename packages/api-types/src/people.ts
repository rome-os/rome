// The People surface's contract, in two nouns — a person, and the accounts
// they are reachable at:
//
//   GET    /api/people              -> PeopleList (curated people only)
//   GET    /api/people/:id          -> PersonResource
//   GET    /api/people/:id/messages -> TimelinePage
//   GET    /api/accounts            -> AccountDirectory
//   GET    /api/accounts/stream     -> AccountStream
//   POST   /api/people              -> PersonResource (201) | LinkConflict (409)
//   POST   /api/people/:id/accounts -> PersonResource | LinkConflict (409)
//   DELETE /api/people/:id/accounts/:channel/:channelUserId -> PersonResource
//   GET    /api/people/:id/outbox   -> OutboxPage
//   POST   /api/people/:id/messages -> OutboxMessage (202) | SendRefusal (409)
//   POST   /api/people/:id/outbox/:messageId/retry -> OutboxMessage (202)
//   DELETE /api/people/:id/outbox/:messageId       -> 204
//
// The rest are request types that lead, with the backend following (issues
// #64, #65):
//
//   PATCH  /api/people/:id           -> PersonResource
//   POST   /api/people/:id/merge     -> PersonResource
//   POST   /api/accounts/:channel/:channelUserId/dismiss  -> DirectoryAccount
//   POST   /api/accounts/:channel/:channelUserId/restore  -> DirectoryAccount
//
// The vocabulary is docs/concepts/people.md's. Rome never mints an account:
// an account is platform-owned, named by the pair (channel, channelUserId) —
// its channel and its own address — and the only fact about who is who that
// Rome contributes is which person it belongs to. So the writes here move a
// link between people; none of them creates or destroys the account under it.
//
// The bond ladder, the merged timeline and the activity order both the person
// listing and the account stream run on live here too. They are the pieces both
// nouns share: a row's `latest` is the head of the timeline the same row opens,
// and a cursor written against one activity listing has to name a position in
// the other. A second definition of any of them is a page boundary the two ends
// disagree about, so they are stated once, here.
//
// The account read is two reads, because two surfaces ask two questions. The
// directory is a contacts list: every account, ordered by name, carrying
// nothing about what anyone said — it is where a guardian looks someone up.
// The stream is the recents surface: ordered by what happened last, carrying
// the line to preview, and it only ever holds accounts something has happened
// on. Each has its own row shape and its own cursor, so neither pays for the
// other's fields and neither order can be resumed with the other's position.

import { STRANGER_PERSON_ID } from "./persons.js";

// ---------------------------------------------------------------------------
// The bond ladder
// ---------------------------------------------------------------------------

/**
 * Every position on the bond ladder a surface renders, in display order.
 *
 * "unknown" and "stranger" are positions on the same ladder as the curated
 * bonds, not separate kinds of thing, and neither is ever stored on a person:
 * an account is unknown by having no link, and dismissed by being linked to
 * the stranger sentinel. Both are read off the links.
 */
export const BOND_LADDER = [
  "unknown",
  "guardian",
  "inner-circle",
  "acquaintance",
  "other",
  "stranger",
] as const;

export type BondLadderLevel = (typeof BOND_LADDER)[number];

/** A level a person row can actually hold: the ladder minus its two computed
 *  positions. */
export type PlacedBondLevel = Exclude<BondLadderLevel, "unknown" | "stranger">;

/**
 * The levels a guardian may place a person at.
 *
 * Guardian is not one of them: the instance serves exactly one, and the
 * ladder's other two positions are read off the links rather than stored.
 */
export const ASSIGNABLE_BOND_LEVELS = ["inner-circle", "acquaintance", "other"] as const;

export type AssignableBondLevel = (typeof ASSIGNABLE_BOND_LEVELS)[number];

export function isAssignableBondLevel(value: unknown): value is AssignableBondLevel {
  return ASSIGNABLE_BOND_LEVELS.includes(value as AssignableBondLevel);
}

/**
 * Bucket a stored `persons.bondLevel` onto the ladder. The column is free text
 * and older rows carry values outside today's enum (e.g. "colleague"), so
 * every reader has to agree on where those land rather than dropping the row
 * from every group.
 */
export function normalizeBondLevel(raw: string): PlacedBondLevel {
  return (BOND_LADDER as readonly string[]).includes(raw) && raw !== "unknown" && raw !== "stranger"
    ? (raw as PlacedBondLevel)
    : "other";
}

// ---------------------------------------------------------------------------
// Ordering and matching, defined the same way in every runtime
// ---------------------------------------------------------------------------

/**
 * Compare two strings by code point, returning zero only for exact equality.
 *
 * `localeCompare` answers zero for strings that are canonically equivalent but
 * distinct — "\u00e9" and "e\u0301" — and its result depends on the running
 * locale, so a server and a client can disagree on the same pair. Neither is
 * acceptable where an order has to be total and has to mean the same thing on
 * both ends of a cursor.
 */
export function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Order two display names the same way in every runtime.
 *
 * Not `localeCompare`, even with a code-point tiebreak behind it. That fallback
 * repairs a tie but cannot repair an inversion, and collations genuinely
 * disagree about order: "\u00e4" sorts before "z" under English and after it
 * under Swedish. The mock runs in a browser and the route runs in Node, so a
 * cursor written by one and read by the other would skip or repeat rows.
 *
 * Case-folded first so "ada" and "Ada" sit together, then by code point.
 * Accented names therefore sort after unaccented ones, which is the price of an
 * order both ends agree on. It is a small price here: the listings sort by
 * activity first, so a name only ever settles a tie between two rows whose
 * newest dynamic landed in the same second.
 */
export function compareDisplayNames(a: string, b: string): number {
  const normalizedA = a.normalize("NFC");
  const normalizedB = b.normalize("NFC");
  const byFolded = compareCodePoints(normalizedA.toLowerCase(), normalizedB.toLowerCase());
  return byFolded !== 0 ? byFolded : compareCodePoints(normalizedA, normalizedB);
}

/**
 * Whether a search box's text is anywhere in what a row can be found by.
 *
 * The rule rather than the haystack: each surface knows which of its own
 * fields are searchable, and every one of them has to normalize the same way
 * or one typed string finds different rows on each.
 *
 * NFC first, the way the orderings normalize: a keyboard that composes "José"
 * should find a row that stored it decomposed, and the reverse.
 */
export function matchesQuery(query: string, haystack: readonly string[]): boolean {
  const q = query.normalize("NFC").trim().toLowerCase();
  if (!q) return true;
  return haystack.join(" ").normalize("NFC").toLowerCase().includes(q);
}

/**
 * Parse a `?level=` value against the levels a surface counts by, or null when
 * it names no view — an unknown filter is a client bug, and answering it as
 * "all" would silently show the wrong rows.
 *
 * Takes the ladder because the surfaces count by different ones: a listing of
 * curated people has no chip for the two positions no person row can hold.
 */
export function parseFilterLevel<L extends string>(
  raw: string | undefined | null,
  levels: readonly L[],
): "all" | L | null {
  if (raw == null || raw === "") return null;
  if (raw === "all") return "all";
  return (levels as readonly string[]).includes(raw) ? (raw as L) : null;
}

/**
 * Whether a value can name a channel in a composed token.
 *
 * Only the first colon of an account ref is structural, so a channel carrying
 * one would make the token ambiguous: "a:b" with user "c" and "a" with user
 * "b:c" both render `a:b:c`. Channel names are short slugs, so refusing the
 * separator costs nothing and removes the ambiguity rather than documenting it.
 */
export function isChannelIdentifier(channel: string): boolean {
  return channel.length > 0 && !channel.includes(":");
}

// ---------------------------------------------------------------------------
// The merged timeline, and the cursor that resumes it
// ---------------------------------------------------------------------------

/**
 * One entry on a person's merged timeline, whichever surface produced it.
 *
 * Deliberately generic: `source` names the producer, `ref` is that producer's
 * own id for the entry, and `body` is the line to render. A Rome App that
 * starts contributing dynamics fills the same five fields instead of
 * extending this shape.
 *
 * `ref` must be unique across everything one `source` can put on one person's
 * timeline, not merely within the conversation it came from. A person holds
 * several accounts, and a producer whose ids are per-conversation (WhatsApp
 * message ids are unique within a chat, not within an account) has to qualify
 * them — `<chat>:<messageId>` — before writing them here.
 * {@link compareTimelineEntries} settles ties on `(source, ref)`, so two
 * entries sharing one within the same second compare equal, serialize to the
 * same cursor, and lose one of the pair on resume.
 */
export interface TimelineEntry {
  source: string;
  /** Epoch seconds. */
  timestamp: number;
  body: string | null;
  direction: "inbound" | "outbound";
  ref: string;
}

/** One page of a person's timeline, newest first. `nextCursor` is opaque and
 *  null once the oldest entry has been sent. */
export interface TimelinePage {
  entries: TimelineEntry[];
  nextCursor: string | null;
}

export const TIMELINE_PAGE_DEFAULT_LIMIT = 100;
export const TIMELINE_PAGE_MAX_LIMIT = 300;

/**
 * The timeline's order: newest first, and total.
 *
 * Producers share no key but the timestamp, and timestamps collide — whole
 * seconds from two stores, and a reply Rome sent recorded against the message
 * it answers. So the order is settled past the timestamp: a reply sits above
 * the line it answers, and `source`/`ref` break what remains. Totality is not
 * cosmetic — it is what lets a cursor name a position and resume there without
 * repeating or skipping an entry.
 */
export function compareTimelineEntries(a: TimelineEntry, b: TimelineEntry): number {
  if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
  if (a.direction !== b.direction) return a.direction === "outbound" ? -1 : 1;
  const bySource = compareCodePoints(a.source, b.source);
  return bySource !== 0 ? bySource : compareCodePoints(a.ref, b.ref);
}

/**
 * The dynamic a row reports as `latest`: the newest entry of that row's own
 * timeline, projected.
 *
 * One definition rather than two. A separate "newest dynamic" comparison
 * settles a same-second tie on its own terms — timestamps are whole seconds and
 * collide — so a row could preview one event while its timeline opened on
 * another, and neither would be wrong. Deriving the preview from the ordering
 * makes that disagreement unrepresentable.
 *
 * `entries` must already be in {@link compareTimelineEntries} order.
 */
export function latestDynamic(entries: readonly TimelineEntry[]): AccountDynamic | null {
  const newest = entries[0];
  return newest
    ? { source: newest.source, timestamp: newest.timestamp, preview: newest.body }
    : null;
}

/**
 * A cursor naming the exact entry a page ended on.
 *
 * Encoded rather than a bare timestamp: the timestamp alone cannot say *which*
 * of a second's entries was the last one sent, so resuming from it drops the
 * rest of that second.
 *
 * Every part is escaped. `source` is whatever a producer calls itself and a
 * Rome App names its own, so neither it nor `ref` can be trusted to leave the
 * separator alone — an unescaped one shifts the split and resumes the page at
 * a position no entry occupies.
 */
export function timelineCursor(entry: TimelineEntry): string {
  return [entry.timestamp, entry.direction, entry.source, entry.ref]
    .map((part) => encodeURIComponent(String(part)))
    .join("|");
}

/** Decode a {@link timelineCursor}, or null when it is not one. */
export function parseTimelineCursor(raw: string | undefined | null): TimelineEntry | null {
  if (!raw) return null;
  const parts = raw.split("|");
  if (parts.length !== 4) return null;
  let decoded: string[];
  try {
    decoded = parts.map(decodeURIComponent);
  } catch {
    return null;
  }
  const [rawTimestamp, direction, source, ref] = decoded;
  const timestamp = Number(rawTimestamp);
  if (rawTimestamp === "" || !Number.isFinite(timestamp)) return null;
  if (direction !== "inbound" && direction !== "outbound") return null;
  if (!ref) return null;
  return { timestamp, direction, source, ref, body: null };
}

/** Whether an entry falls after a cursor in {@link compareTimelineEntries}
 *  order — i.e. belongs on a later page than the one that cursor ended. */
export function isAfterTimelineCursor(entry: TimelineEntry, cursor: TimelineEntry): boolean {
  return compareTimelineEntries(cursor, entry) < 0;
}

/**
 * The page size a `?limit=` value asks for: clamped to `max`, and `fallback`
 * for anything that does not name a positive count — absent, empty, zero,
 * negative, or not a number.
 *
 * Never zero. A limit of zero answers an empty page with no cursor, which a
 * caller cannot tell from an exhausted listing, so it would silently truncate
 * the read rather than reporting a bad request.
 */
function pageLimit(
  raw: string | number | null | undefined,
  bounds: { fallback: number; max: number },
): number {
  const requested = Number(raw);
  return Number.isFinite(requested) && requested >= 1
    ? Math.min(Math.floor(requested), bounds.max)
    : bounds.fallback;
}

/** {@link pageLimit} for one page of a timeline. */
export function timelinePageLimit(raw: string | number | null | undefined): number {
  return pageLimit(raw, {
    fallback: TIMELINE_PAGE_DEFAULT_LIMIT,
    max: TIMELINE_PAGE_MAX_LIMIT,
  });
}

/**
 * The newest thing that happened on an account, whichever surface it happened
 * on: what a listing sorts by and what a row shows.
 *
 * A row's `latest` is always {@link latestDynamic} of the history that row
 * opens, so the two are one shape rather than two that can disagree. A producer
 * that computes it any other way can preview one event while its timeline opens
 * on another, and a reader has no way to reconcile the pair.
 *
 * `source` is a channel name today ("whatsapp", "telegram"); a Rome App that
 * starts producing dynamics writes its own name here and the surface renders it
 * through the same glyph lookup.
 */
export interface AccountDynamic {
  source: string;
  /** Epoch seconds. */
  timestamp: number;
  /** One line, already trimmed to a preview; null when the dynamic carries no
   *  text (an image, a call, an app event with no body). */
  preview: string | null;
}

/**
 * What the guardian has decided about an account.
 *
 * "unlinked" is the absence of a decision rather than one Rome writes down: an
 * account it has observed and nobody has placed. The other two are decisions —
 * a link onto a person, and a dismissal, which files the account under the
 * stranger sentinel.
 *
 * The three partition the directory, so their counts sum to it.
 */
export const ACCOUNT_STATES = ["unlinked", "linked", "dismissed"] as const;

export type AccountState = (typeof ACCOUNT_STATES)[number];

/** Parse a `?state=` value, or null when it names no state — an unknown filter
 *  is a caller's bug, and answering it as the whole directory would silently
 *  show the wrong accounts. */
export function parseAccountState(raw: string | undefined | null): AccountState | null {
  if (raw == null || raw === "") return null;
  return (ACCOUNT_STATES as readonly string[]).includes(raw) ? (raw as AccountState) : null;
}

/** How an account's link renders: its state, and the person it names. */
export interface AccountPresentation {
  state: AccountState;
  /** The person the account is linked to, or null in either other state. */
  personId: string | null;
  personName: string | null;
}

/**
 * Read a link the way every surface has to read it.
 *
 * The stranger sentinel is a row in the persons table that every dismissed
 * account is mapped onto, not someone the guardian knows. So a dismissal
 * answers a state and no person: a caller handed the sentinel's id would render
 * it as a person, open a timeline merging everyone ever dismissed, and address
 * writes at a row no write may touch.
 */
export function accountPresentation(
  link: { personId: string; displayName: string } | null | undefined,
): AccountPresentation {
  if (link == null) return { state: "unlinked", personId: null, personName: null };
  if (link.personId === STRANGER_PERSON_ID) {
    return { state: "dismissed", personId: null, personName: null };
  }
  return { state: "linked", personId: link.personId, personName: link.displayName };
}

/**
 * One account in the directory: one person on one channel, however many
 * addresses that channel reaches them at.
 *
 * `channel` and `channelUserId` name it — the pair a link, a dismissal or a
 * timeline read carries. `channelUserId` is the account's own address, kept
 * under its wire name here. {@link accountRef} renders the pair as the single
 * token a key or a path segment needs.
 *
 * A contacts list's row, so it carries who the account is and nothing about
 * what it has done — not a preview, not a count, not even whether there is
 * anything to count. {@link StreamAccount} is the same account on the recents
 * surface, where the activity is the point.
 */
export interface DirectoryAccount {
  channel: string;
  /** The address the channel folds its other addresses of this account onto.
   *  Stable across a re-sync and across which address a message arrives on. */
  channelUserId: string;
  /**
   * Every address the channel can reach the account at, `channelUserId`
   * included, ordered by code point.
   *
   * A search reads these, so an omitted one is an account the guardian cannot
   * find by the phone number they know.
   */
  addresses: string[];
  /**
   * What the account's own platform calls it, then the name its sender put on a
   * message, then the address itself. Never empty, and never the linked
   * person's name — {@link personName} answers that, and a guardian renaming a
   * person does not rename the account.
   */
  displayName: string;
  state: AccountState;
  /** Never the stranger sentinel's id — see {@link accountPresentation}. */
  personId: string | null;
  personName: string | null;
}

/**
 * One account on the stream: the directory's account, plus the activity the
 * stream orders and previews by.
 *
 * `latest` is never null. The stream is the recents surface and only carries
 * accounts something has happened on, so an account with nothing on record is
 * absent rather than present with an empty preview.
 */
export interface StreamAccount extends DirectoryAccount {
  /**
   * The newest thing on record for this account, which is exactly the first
   * entry of the {@link TimelinePage} this row opens onto.
   *
   * The one message-derived fact either account surface carries. How much is
   * behind it is deliberately not here: a count is a second question about the
   * same history, asked of every row of a whole listing, and a row that showed
   * one would be reporting a number nothing beneath it renders.
   */
  latest: AccountDynamic;
}

/** How many accounts sit in each state. */
export interface AccountCounts extends Record<AccountState, number> {}

/**
 * One page of the account directory, by display name.
 *
 * `counts` describes the whole directory the query admits, never the page — so
 * every number a client renders is the server's, and no chip collapses as the
 * client pages.
 */
export interface AccountDirectory {
  accounts: DirectoryAccount[];
  /** Opaque, and null on the last page. */
  nextCursor: string | null;
  /**
   * Per state, over everything the query admits and before `state` narrows the
   * page — so each chip's number is the size of the listing that chip shows.
   *
   * Every account, the whole mirrored address book included: the directory is
   * a contacts list and holds nothing back, so "unlinked" here counts everyone
   * Rome has not placed rather than the senders waiting on a decision. The
   * stream's own counts answer that narrower question, over the accounts
   * something has actually happened on.
   */
  counts: AccountCounts;
}

/**
 * One page of the account stream, newest activity first.
 *
 * `counts` describes every account with activity the query admits, before
 * `state` narrows the page — which is what makes the Unknown chip's number the
 * senders actually waiting on a decision rather than the size of an address
 * book.
 */
export interface AccountStream {
  accounts: StreamAccount[];
  /** Opaque, and null on the last page. */
  nextCursor: string | null;
  counts: AccountCounts;
}

/**
 * Render the pair naming an account as one token, for a client's row key and
 * for the position a cursor names.
 *
 * Only the first colon is structural, so a channel carrying one would make the
 * token ambiguous. Channel names are short slugs, so refusing the separator
 * costs nothing and removes the ambiguity rather than documenting it. A caller
 * passing one has a bug that a silently collapsed row would hide until a write
 * landed on the wrong account.
 */
export function accountRef(account: { channel: string; channelUserId: string }): string {
  if (!isChannelIdentifier(account.channel)) {
    throw new Error(
      `channel must be non-empty and free of ":" — received ${JSON.stringify(account.channel)}`,
    );
  }
  if (!account.channelUserId) throw new Error("channelUserId must be non-empty");
  return `${account.channel}:${account.channelUserId}`;
}

/** What `?q=` matches: the display name, the linked person's name, and every
 *  address — so a phone number finds an account the platform named something
 *  else, and a person's name finds the accounts they were placed on. */
export function accountMatchesQuery(account: DirectoryAccount, query: string): boolean {
  return matchesQuery(query, [
    account.displayName,
    account.personName ?? "",
    account.channel,
    ...account.addresses,
  ]);
}

/**
 * Where one account sits in the directory's order: the name it is filed under,
 * and its ref to settle a tie.
 *
 * Not the stream's tuple. The directory is a contacts list — ordered by name,
 * carrying no activity at all — so a cursor naming a timestamp would name a
 * position this order does not have, and a page boundary the two ends of the
 * cursor disagree about.
 *
 * A position rather than a row id: between two requests an account is linked,
 * dismissed or renamed, and a cursor that had to find that row again would
 * answer the next page empty and truncate the listing.
 */
export interface AccountCursor {
  displayName: string;
  /** {@link accountRef} of the account the page ended on. */
  ref: string;
}

export function accountCursorOf(account: DirectoryAccount): AccountCursor {
  return { displayName: account.displayName, ref: accountRef(account) };
}

/**
 * The directory's order: by display name, ties broken by ref so the sequence is
 * total — which is what lets a cursor resume it.
 *
 * {@link compareDisplayNames} rather than a collation, for the reason it
 * states: the dashboard's mock orders in a browser and the route orders in
 * Node, and a cursor written by one is read by the other.
 */
export function compareAccountCursors(a: AccountCursor, b: AccountCursor): number {
  const byName = compareDisplayNames(a.displayName, b.displayName);
  return byName !== 0 ? byName : compareCodePoints(a.ref, b.ref);
}

/** Encode the position a page ended at. Both parts are escaped: a display name
 *  is whatever a platform calls the account, and a ref carries a jid, so
 *  neither can be trusted to leave the separator alone. */
export function encodeAccountCursor(cursor: AccountCursor): string {
  return [cursor.displayName, cursor.ref].map((part) => encodeURIComponent(part)).join("|");
}

/** Decode an {@link encodeAccountCursor}, or null when it is not one. */
export function parseAccountCursor(raw: string | undefined | null): AccountCursor | null {
  if (!raw) return null;
  const parts = raw.split("|");
  if (parts.length !== 2) return null;
  let decoded: string[];
  try {
    decoded = parts.map(decodeURIComponent);
  } catch {
    return null;
  }
  const [displayName, ref] = decoded;
  if (!ref) return null;
  return { displayName, ref };
}

/** {@link compareAccountCursors} over the accounts themselves. */
export function compareAccounts(a: DirectoryAccount, b: DirectoryAccount): number {
  return compareAccountCursors(accountCursorOf(a), accountCursorOf(b));
}

/** Whether an account falls after a cursor in {@link compareAccounts} order —
 *  i.e. belongs on a later page than the one that cursor ended. */
export function isAfterAccountCursor(account: DirectoryAccount, cursor: AccountCursor): boolean {
  return compareAccountCursors(cursor, accountCursorOf(account)) < 0;
}

/**
 * Where one row sits in an activity order: the tuple the ordering reads, and
 * nothing else. A cursor carries this rather than a row id, so resuming needs a
 * position rather than a row that still exists.
 *
 * One position type over both activity listings. The account stream and the
 * person listing are two views of the same activity, so a second tuple would be
 * a second answer to "who is at the top" — and the reasons it is a position
 * rather than a row id, and the reasons every part is escaped, would live in
 * two places that can be fixed apart. Named for the stream because that is the
 * listing that pages.
 */
export interface StreamCursor {
  /** The row's `latest.timestamp`, or null for a row that has never done
   *  anything — those sort last. A stream row always carries one; a person
   *  nobody has ever written to does not. */
  timestamp: number | null;
  displayName: string;
  id: string;
}

/**
 * The order both activity listings run on: newest activity first, rows that
 * have never done anything last, ties broken by name and then id so the
 * sequence is total — which is what lets a cursor resume it.
 */
export function compareStreamCursors(a: StreamCursor, b: StreamCursor): number {
  const aAt = a.timestamp;
  const bAt = b.timestamp;
  if ((aAt == null) !== (bAt == null)) return aAt == null ? 1 : -1;
  if (aAt !== bAt) return (bAt ?? 0) - (aAt ?? 0);
  const byName = compareDisplayNames(a.displayName, b.displayName);
  return byName !== 0 ? byName : compareCodePoints(a.id, b.id);
}

/**
 * Encode the position a page ended at.
 *
 * The whole ordering tuple, not the last row's id: between two requests a row
 * is linked, merged away, or dismissed — every one of them an ordinary write on
 * this surface — and a cursor that has to find that row again answers the next
 * page empty and truncates the listing until the query is restarted. A position
 * is still a position after the row at it is gone.
 *
 * Each part is escaped, because a display name is guardian-supplied text and an
 * account ref carries a jid; neither can be trusted to avoid the separator.
 */
export function encodeStreamCursor(cursor: StreamCursor): string {
  return [cursor.timestamp ?? "", cursor.displayName, cursor.id]
    .map((part) => encodeURIComponent(String(part)))
    .join("|");
}

/** Decode an {@link encodeStreamCursor}, or null when it is not one. */
export function parseStreamCursor(raw: string | undefined | null): StreamCursor | null {
  if (!raw) return null;
  const parts = raw.split("|");
  if (parts.length !== 3) return null;
  let decoded: string[];
  try {
    decoded = parts.map(decodeURIComponent);
  } catch {
    return null;
  }
  const [rawTimestamp, displayName, id] = decoded;
  if (!id) return null;
  const timestamp = rawTimestamp === "" ? null : Number(rawTimestamp);
  if (timestamp !== null && !Number.isFinite(timestamp)) return null;
  return { timestamp, displayName, id };
}

/** The ordering tuple for any row that carries one, given its id. Widened past
 *  either row type so both activity listings order through
 *  {@link compareStreamCursors} rather than restating it. */
function activityPosition(
  row: { displayName: string; latest: AccountDynamic | null },
  id: string,
): StreamCursor {
  return { timestamp: row.latest?.timestamp ?? null, displayName: row.displayName, id };
}

export function streamCursorOf(account: StreamAccount): StreamCursor {
  return activityPosition(account, accountRef(account));
}

/** The stream's order: newest activity first, ties broken by name and then ref
 *  so the sequence is total. */
export function compareStreamAccounts(a: StreamAccount, b: StreamAccount): number {
  return compareStreamCursors(streamCursorOf(a), streamCursorOf(b));
}

/** Whether an account falls after a cursor in {@link compareStreamAccounts}
 *  order — i.e. belongs on a later page than the one that cursor ended. */
export function isAfterStreamCursor(account: StreamAccount, cursor: StreamCursor): boolean {
  return compareStreamCursors(cursor, streamCursorOf(account)) < 0;
}

/** How many accounts one page carries when the caller names no limit, and the
 *  ceiling it is clamped to. A synced address book is thousands of rows, so the
 *  default is a screenful of them rather than all of them. */
export const ACCOUNT_PAGE_DEFAULT_LIMIT = 200;
export const ACCOUNT_PAGE_MAX_LIMIT = 500;

/** {@link pageLimit} for one page of the account directory. */
export function accountPageLimit(raw: string | number | null | undefined): number {
  return pageLimit(raw, { fallback: ACCOUNT_PAGE_DEFAULT_LIMIT, max: ACCOUNT_PAGE_MAX_LIMIT });
}

/**
 * Cut one page out of the directory, with the numbers that describe the whole
 * of it.
 *
 * Takes every account there is, in any order: the order is this function's, so
 * a producer cannot page one order while a client renders another.
 *
 * `query` scopes everything, including the counts. `state` and the cursor scope
 * the page alone, so a client filtered to one chip still reads every chip's
 * number, and a client on page four reads the same numbers it read on page one.
 *
 * Every account the query matches is on the listing. A contacts app holds
 * nobody back: a lookup that answered "no such account" for a contact the
 * mirror holds is a worse answer than a long list, and paging is what a long
 * list is for.
 */
export function sliceAccountDirectory(
  directory: readonly DirectoryAccount[],
  options: {
    query?: string | null;
    state?: AccountState | null;
    cursor?: AccountCursor | null;
    limit?: number | null;
  } = {},
): AccountDirectory {
  const query = options.query?.trim() ?? "";
  const matching = query ? directory.filter((a) => accountMatchesQuery(a, query)) : directory;

  const counts: AccountCounts = { unlinked: 0, linked: 0, dismissed: 0 };
  for (const account of matching) counts[account.state] += 1;

  // The sort key is built once per account rather than once per comparison: it
  // renders a ref and a directory is thousands of rows, so a comparator that
  // rebuilds it pays for that on every one of N log N comparisons.
  const ordered = matching
    .map((account) => ({ account, at: accountCursorOf(account) }))
    .sort((a, b) => compareAccountCursors(a.at, b.at))
    .map((entry) => entry.account);
  const state = options.state;
  const scoped = state ? ordered.filter((a) => a.state === state) : ordered;
  const cursor = options.cursor;
  const remaining = cursor ? scoped.filter((a) => isAfterAccountCursor(a, cursor)) : scoped;

  const accounts = remaining.slice(0, accountPageLimit(options.limit));
  const last = accounts.at(-1);
  const nextCursor =
    remaining.length > accounts.length && last ? encodeAccountCursor(accountCursorOf(last)) : null;

  return { accounts, nextCursor, counts };
}

/**
 * Cut one page out of the stream, with the counts that describe the whole of
 * it.
 *
 * Takes every account something has happened on, in any order — the ordering is
 * this function's, as the directory's is {@link sliceAccountDirectory}'s. An
 * account with nothing on record never reaches here: it has no position in an
 * order made of timestamps, and no reader of a recents surface is asking after
 * it.
 *
 * `query` scopes the counts as well as the page, and `state` and the cursor
 * scope the page alone — the same split the directory makes, and for the same
 * reason: a client filtered to one chip still renders every chip's number.
 */
export function sliceAccountStream(
  stream: readonly StreamAccount[],
  options: {
    query?: string | null;
    state?: AccountState | null;
    cursor?: StreamCursor | null;
    limit?: number | null;
  } = {},
): AccountStream {
  const query = options.query?.trim() ?? "";
  const matching = query ? stream.filter((a) => accountMatchesQuery(a, query)) : stream;

  const counts: AccountCounts = { unlinked: 0, linked: 0, dismissed: 0 };
  for (const account of matching) counts[account.state] += 1;

  const ordered = matching
    .map((account) => ({ account, at: streamCursorOf(account) }))
    .sort((a, b) => compareStreamCursors(a.at, b.at))
    .map((entry) => entry.account);
  const state = options.state;
  const scoped = state ? ordered.filter((a) => a.state === state) : ordered;
  const cursor = options.cursor;
  const remaining = cursor ? scoped.filter((a) => isAfterStreamCursor(a, cursor)) : scoped;

  const accounts = remaining.slice(0, accountPageLimit(options.limit));
  const last = accounts.at(-1);
  const nextCursor =
    remaining.length > accounts.length && last ? encodeStreamCursor(streamCursorOf(last)) : null;

  return { accounts, nextCursor, counts };
}

/**
 * One account as it appears under the person linked to it.
 *
 * `(channel, channelUserId)` names the account — its channel and its own
 * address. Rome never mints one: every pair here is observed from a message or
 * from a channel's address book. `displayName` is what the platform calls it,
 * the raw identifier being only the last resort. The directory's
 * {@link DirectoryAccount} is the same account seen from the other side, with
 * what Rome decided about it.
 */
export interface LinkedAccount {
  channel: string;
  channelUserId: string;
  displayName: string;
  /** Whether Rome can send here, and when it cannot, which of the reasons it
   *  is. See {@link AccountSendState}. */
  send: AccountSendState;
  /**
   * When this account itself was last active, in epoch seconds, or null when
   * nothing has ever passed on it.
   *
   * Per account rather than per person, and that is the point: the person's
   * own {@link PersonResource.latest} names a channel and not an address, so it
   * cannot say which of two accounts on one channel was the recent one. This
   * can, which is what lets a composer open on the account the guardian last
   * heard from without inventing the answer.
   */
  latestAt: number | null;
}

/**
 * Whether Rome can send a message to an account, and why not when it cannot.
 *
 * Four states rather than a boolean, because the three failures are different
 * things to a reader and to a retry: one is fixed by connecting a channel, one
 * is a permanent fact about the channel, and one clears on its own once a
 * direct conversation exists.
 *
 * - `yes` — the channel is connected and can address this account directly.
 * - `not-connected` — no live connection for the channel. The guardian fixes
 *   this in Settings.
 * - `unsupported` — the connection is live but does not do direct messaging.
 *   LinkedIn mirrors an inbox it cannot write to; a channel Rome has not
 *   taught to send reads the same way. Why is a fact about the channel rather
 *   than about this account, so the copy is keyed on the channel name and no
 *   reason string crosses the wire — the dashboard localizes it, the same way
 *   it already localizes every channel's own label.
 * - `no-conversation` — the channel sends, but has no thread that reaches this
 *   account yet, and could not open one. Per account, and recoverable.
 */
export type AccountSendState = "yes" | "not-connected" | "unsupported" | "no-conversation";

export function canSend(account: Pick<LinkedAccount, "send">): boolean {
  return account.send === "yes";
}

/**
 * The account a composer opens on: the sendable one that was active most
 * recently, ties broken by address so the answer is the same on every reload.
 *
 * A default, not an inference. Rome never picks a recipient on the guardian's
 * behalf — {@link SendMessageRequest} names the account and has no form that
 * omits it. This only decides which of the offered accounts is filled in
 * first, and the surface showing it is expected to show it.
 *
 * Null when the person holds no account Rome can send to, which a caller must
 * render as the reason rather than as an empty composer.
 */
export function defaultSendAccount(accounts: readonly LinkedAccount[]): LinkedAccount | null {
  const sendable = accounts.filter(canSend);
  if (sendable.length === 0) return null;
  return [...sendable].sort(
    (a, b) =>
      (b.latestAt ?? 0) - (a.latestAt ?? 0) || compareCodePoints(a.channelUserId, b.channelUserId),
  )[0]!;
}

/**
 * A person with their accounts and their activity across all of them.
 *
 * `bondLevel` is the stored value, free text included: older rows carry levels
 * outside today's ladder ("colleague"), and a reader buckets them with
 * {@link normalizeBondLevel} rather than the contract pretending they cannot
 * exist.
 *
 * `latest` and `messageCount` describe one history — the merged timeline
 * `GET /api/people/:id/messages` pages. `latest` is {@link latestDynamic} of
 * it and `messageCount` is how many entries it holds, so the line a row
 * previews is the line its dossier opens on, and the number beside it counts
 * what the dossier will show. A group conversation contributes to neither: a
 * timeline entry names no sender, so nothing said in a room of ten people is
 * attributable to one of them.
 *
 * `memoryPath` is the profile Rome has written about them, as a path under the
 * memory root — the same address the memory file browser reads. Null when no
 * profile has been written: nothing writes one when a person is created, so a
 * path here means a file a reader can actually open.
 */
export interface PersonResource {
  id: string;
  displayName: string;
  bondLevel: string;
  accounts: LinkedAccount[];
  messageCount: number;
  latest: AccountDynamic | null;
  memoryPath: string | null;
}

/**
 * `GET /api/people` — every curated person, and the numbers its filter chips
 * show.
 *
 * Unpaged, unlike the account directory: curated people are entered one at a
 * time by a guardian, so the listing is bounded by hand. The account directory
 * is a mirrored address book of thousands and pages.
 *
 * The stranger sentinel never appears. It is a row in the persons table that
 * dismissed accounts are linked to — structure, not someone the guardian knows
 * — and `GET /api/people/:id` answers 404 for its id.
 */
export interface PeopleList {
  people: PersonResource[];
  counts: PersonCounts;
}

/** The bond levels a curated person can be counted under, in display order —
 *  every level {@link normalizeBondLevel} can answer, which is the ladder
 *  minus the two positions no person row holds. */
export const PERSON_BOND_LEVELS: readonly PlacedBondLevel[] = [
  "guardian",
  "inner-circle",
  "acquaintance",
  "other",
];

export type PersonBondLevel = PlacedBondLevel;

/** A level the listing can be filtered and counted by: a bond level, or "all"
 *  — every curated person whatever their level. */
export type PersonFilterLevel = "all" | PersonBondLevel;

/**
 * How many people sit at each level.
 *
 * Counted over everything `?q=` matches rather than the rows `?level=`
 * returned: the chips are how a client moves between the levels, so a count
 * taken over the returned rows would report zero for every chip but the one
 * already selected, and the guardian could never leave it.
 *
 * "all" is the sum of the others — every level here is one a person is
 * actually placed at.
 */
export interface PersonCounts extends Record<PersonFilterLevel, number> {}

/** Whether a person belongs to a chip's view. */
export function personMatchesLevel(person: PersonResource, level: PersonFilterLevel): boolean {
  return level === "all" || normalizeBondLevel(person.bondLevel) === level;
}

export function parsePersonFilterLevel(raw: string | undefined | null): PersonFilterLevel | null {
  return parseFilterLevel(raw, PERSON_BOND_LEVELS);
}

export function countPeople(people: readonly PersonResource[]): PersonCounts {
  const counts: PersonCounts = {
    all: 0,
    guardian: 0,
    "inner-circle": 0,
    acquaintance: 0,
    other: 0,
  };
  for (const person of people) {
    counts[normalizeBondLevel(person.bondLevel)] += 1;
    counts.all += 1;
  }
  return counts;
}

/**
 * What `?q=` matches: the person's own name, and every account they hold —
 * both what the platform calls it and the identifier itself.
 *
 * The identifiers are in the haystack because a guardian searches with what
 * they have: a phone number they were given, a member id pasted from a profile
 * URL. A saved name would otherwise hide the account they are looking for.
 */
export function personMatchesQuery(person: PersonResource, query: string): boolean {
  return matchesQuery(query, [
    person.displayName,
    ...person.accounts.flatMap((account) => [
      account.displayName,
      account.channel,
      account.channelUserId,
    ]),
  ]);
}

/**
 * The listing's order: newest activity first, people who have never said
 * anything last, ties broken by name and then id.
 *
 * The account stream's order, not a second one that happens to agree — the two
 * listings are two views of the same activity, so an order defined twice is two
 * answers to "who is at the top" and, once this listing takes a cursor, a row
 * skipped or repeated at every page boundary.
 */
export function comparePeople(a: PersonResource, b: PersonResource): number {
  return compareStreamCursors(activityPosition(a, a.id), activityPosition(b, b.id));
}

/**
 * `POST /api/people` — create, with optional atomic linking.
 *
 * Atomic means both-or-neither: if any named account is linked to a real
 * person, the whole request refuses with a {@link LinkConflict} and no person
 * is created. Accounts the dismissal machinery holds link silently, same as
 * {@link LinkAccountRequest}.
 */
export interface CreatePersonRequest {
  displayName: string;
  /** Defaults to "other". */
  bondLevel?: AssignableBondLevel;
  accounts?: { channel: string; channelUserId: string }[];
}

/** A create request with its defaults applied: what the write is given. */
export type NewPerson = Required<CreatePersonRequest>;

/**
 * Read a request body as a {@link NewPerson}, or say what is wrong with it.
 *
 * The rule rather than any one route's rule, so the backend and the dashboard's
 * mock refuse the same bodies with the same words — the page renders the
 * `error` string, so the wording is part of what a client is written against.
 *
 * A name is trimmed before it is judged, and whitespace alone is no name: it
 * slugs to nothing, so accepting it would mint a person whose id is a uuid the
 * guardian never sees a reason for.
 */
export function parseCreatePersonRequest(body: unknown): { person: NewPerson } | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "displayName is required" };
  const raw = body as Record<string, unknown>;

  const displayName = typeof raw.displayName === "string" ? raw.displayName.trim() : "";
  if (!displayName) return { error: "displayName is required" };

  if (raw.bondLevel !== undefined && !isAssignableBondLevel(raw.bondLevel)) {
    return { error: `bondLevel must be one of ${ASSIGNABLE_BOND_LEVELS.join(", ")}` };
  }

  if (raw.accounts !== undefined && !Array.isArray(raw.accounts)) {
    return { error: "accounts must be an array of { channel, channelUserId }" };
  }
  // Keyed rather than pushed: naming one account twice asks for the state
  // naming it once produces, and the link table holds one row per account, so
  // the repeat would abort the write over a request that was never ambiguous.
  const accounts = new Map<string, NewPerson["accounts"][number]>();
  for (const entry of (raw.accounts ?? []) as unknown[]) {
    const account = entry as Partial<NewPerson["accounts"][number]> | null;
    if (!account?.channel || !account.channelUserId) {
      return { error: "each account needs a channel and a channelUserId" };
    }
    const ref = { channel: account.channel, channelUserId: account.channelUserId };
    accounts.set(`${ref.channel}\n${ref.channelUserId}`, ref);
  }

  return {
    person: { displayName, bondLevel: raw.bondLevel ?? "other", accounts: [...accounts.values()] },
  };
}

/** `PATCH /api/people/:id`. The guardian's bond level refuses to change. */
export interface UpdatePersonRequest {
  displayName?: string;
  bondLevel?: AssignableBondLevel;
}

/**
 * Read a request body as an {@link UpdatePersonRequest}, or say what is wrong
 * with it. The rule rather than any one route's rule, for the reason
 * {@link parseCreatePersonRequest} states.
 *
 * An omitted field is one the update leaves alone, which is the whole
 * difference between this and a write of the person: a body naming only a bond
 * level must not blank the name. So a body naming neither is the empty update
 * rather than a bad request — it asks for the state the person is already in,
 * which is also what a retry of an update that already landed asks for.
 *
 * A body that is not an object is refused all the same. It names no field to
 * leave alone, so reading it as the empty update would answer a malformed
 * request with the person and a 200.
 *
 * `bondLevel` is checked against the levels a guardian may assign, so a body
 * naming "guardian" is refused here whoever it addresses. Whether the person
 * being addressed may move at all is `protectedPersonReason`'s question in
 * ./persons.ts, and it is a different one.
 */
export function parseUpdatePersonRequest(
  body: unknown,
): { update: UpdatePersonRequest } | { error: string } {
  if (typeof body !== "object" || body === null) {
    return { error: "displayName or bondLevel is required" };
  }
  const raw = body as Record<string, unknown>;
  const update: UpdatePersonRequest = {};

  if (raw.displayName !== undefined) {
    // Trimmed before it is judged, as a create's name is: whitespace alone is
    // no name, and storing it would leave the person unfindable by the name
    // the guardian typed.
    const displayName = typeof raw.displayName === "string" ? raw.displayName.trim() : "";
    if (!displayName) return { error: "displayName cannot be empty" };
    update.displayName = displayName;
  }

  if (raw.bondLevel !== undefined) {
    if (!isAssignableBondLevel(raw.bondLevel)) {
      return { error: `bondLevel must be one of ${ASSIGNABLE_BOND_LEVELS.join(", ")}` };
    }
    update.bondLevel = raw.bondLevel;
  }

  return { update };
}

/**
 * `POST /api/people/:id/accounts` — the link verb.
 *
 * Compare-and-swap on the account's current owner: linking an unlinked or
 * dismissed account needs no `transferFrom`, re-linking to the same person is
 * an idempotent no-op, and taking an account from another person requires
 * `transferFrom` naming that person exactly. Anything else answers 409 with a
 * {@link LinkConflict}. The explicitness is the point — a transfer
 * re-attributes the account's whole message history, so it never happens as
 * the side effect of an optimistic retry.
 */
export interface LinkAccountRequest {
  channel: string;
  channelUserId: string;
  transferFrom?: string;
}

/**
 * The request a body carries, or null when it is not one — a channel
 * {@link accountRef} cannot name and an empty identifier name no account, and
 * an empty `transferFrom` is a caller that meant to name an owner.
 */
export function parseLinkAccountRequest(body: unknown): LinkAccountRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const { channel, channelUserId, transferFrom } = body as Record<string, unknown>;
  if (typeof channel !== "string" || !isChannelIdentifier(channel)) return null;
  if (typeof channelUserId !== "string" || channelUserId === "") return null;
  if (transferFrom === undefined) return { channel, channelUserId };
  if (typeof transferFrom !== "string" || transferFrom === "") return null;
  return { channel, channelUserId, transferFrom };
}

/**
 * The 409 body for a refused link or dismissal: names the current owner so the
 * caller can render the conflict and offer an explicit transfer. Never the
 * stranger sentinel — a dismissal-held account never conflicts.
 *
 * The owner is null in one case: a `transferFrom` naming someone who does not
 * hold the account, where the account is now held by nobody. The caller's view
 * of the owner is stale either way, and this is the answer that says so.
 */
export interface LinkConflict {
  error: string;
  channel: string;
  channelUserId: string;
  linkedPersonId: string | null;
  linkedPersonName: string | null;
}

/** Phrase a {@link LinkConflict}, wording included, so every route and the
 *  mock refuse in the same words. */
export function linkConflict(
  account: { channel: string; channelUserId: string },
  holder: { id: string; displayName: string } | null,
): LinkConflict {
  return {
    error: holder
      ? `${account.channel}:${account.channelUserId} is already linked to ${holder.displayName}`
      : `${account.channel}:${account.channelUserId} is linked to nobody`,
    channel: account.channel,
    channelUserId: account.channelUserId,
    linkedPersonId: holder?.id ?? null,
    linkedPersonName: holder?.displayName ?? null,
  };
}

/** `POST /api/people/:id/merge` — :id absorbs `from`: every link transfers
 *  atomically, then `from` is deleted. First-class rather than N transfers
 *  and a delete, because history re-attribution must not half-happen. */
export interface MergeRequest {
  from: string;
}

/**
 * Read a request body as a {@link MergeRequest} against the person absorbing
 * it, or say what is wrong with it.
 *
 * A merge into oneself is refused here rather than being read as a no-op: the
 * operation moves a person's links away and then deletes them, so a caller
 * that names the same person twice is describing a write that would end with
 * the survivor gone. That the two ids are one is visible in the request, so it
 * never reaches a transaction.
 */
export function parseMergeRequest(
  body: unknown,
  into: string,
): { merge: MergeRequest } | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "from is required" };
  const { from } = body as Record<string, unknown>;
  if (typeof from !== "string" || from === "") return { error: "from is required" };
  if (from === into) return { error: "a person cannot be merged into themselves" };
  return { merge: { from } };
}

// ---------------------------------------------------------------------------
// Display names a channel account falls back to
// ---------------------------------------------------------------------------

/**
 * A phone-shaped rendering of a WhatsApp jid or raw number, or null when the
 * value has no digits to show (`@lid` and group jids carry none).
 *
 * Display-name derivation is server-side (the directory answers with final
 * display names), but the mock backend and the chat dialog derive the same
 * fallback, so the formatter lives with the contract they share.
 */
export function formatWhatsAppPhone(value: string | null | undefined): string | null {
  if (!value || value.endsWith("@lid") || value.endsWith("@g.us")) return null;
  // The device suffix is cut at the first colon rather than matched, because a
  // jid is untrusted input and `/:.+$/` over a run of colons backtracks
  // quadratically.
  const bare = value.replace(/@s\.whatsapp\.net$/, "");
  const colon = bare.indexOf(":");
  const user = colon === -1 ? bare : bare.slice(0, colon);
  const digits = user.replace(/\D/g, "");
  if (digits.length === 0) return null;
  // A jid carries the country code, so grouping is only safe where the code is
  // unambiguous. +1 is; a bare 10-digit number is not — it is a Singapore or
  // Hong Kong number as readily as a US one, and guessing renders someone's
  // number as a country they are not in.
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return `+${digits}`;
}

/**
 * The display name for a WhatsApp account nobody has curated: the guardian's
 * saved name, then the contact's own push name, then the verified business
 * name, then the chat's name, then the formatted phone. Callers append their
 * own last-resort label when even the phone is unrenderable.
 */
export function whatsAppDisplayName(contact: {
  jid: string;
  phoneNumber: string | null;
  name: string | null;
  notify: string | null;
  verifiedName: string | null;
  chatName: string | null;
}): string | null {
  return (
    contact.name ||
    contact.notify ||
    contact.verifiedName ||
    contact.chatName ||
    formatWhatsAppPhone(contact.phoneNumber || contact.jid)
  );
}

// ---------------------------------------------------------------------------
// Sending, and the outbox a send lives in until it lands
// ---------------------------------------------------------------------------

/**
 * `POST /api/people/:id/messages` — say something to one of a person's
 * accounts.
 *
 * The account is named, always. There is no shape of this request that omits
 * it and no rule anywhere that fills it in, because every rule that could is a
 * rule that decides who receives a message on evidence too thin to carry it:
 * a timeline entry names its channel and not its address, so "reply where they
 * last wrote" cannot separate two numbers on one channel, and "use another
 * channel when this one is down" silently sends somewhere nobody chose.
 * {@link defaultSendAccount} exists for surfaces that want a preselected
 * account, and it is a default on screen rather than a decision off it.
 */
export interface SendMessageRequest {
  channel: string;
  channelUserId: string;
  text: string;
}

export function parseSendMessageRequest(
  body: unknown,
): { request: SendMessageRequest } | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "body must be an object" };
  const raw = body as Record<string, unknown>;
  const channel = typeof raw.channel === "string" ? raw.channel.trim() : "";
  const channelUserId = typeof raw.channelUserId === "string" ? raw.channelUserId.trim() : "";
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  if (!channel) return { error: "channel is required" };
  if (!isChannelIdentifier(channel)) return { error: "channel must not contain ':'" };
  if (!channelUserId) return { error: "channelUserId is required" };
  if (!text) return { error: "text is required" };
  if (text.length > SEND_MESSAGE_MAX_LENGTH) {
    return { error: `text must be at most ${SEND_MESSAGE_MAX_LENGTH} characters` };
  }
  return { request: { channel, channelUserId, text } };
}

/** Long enough for anything a person types, short enough that no adapter has to
 *  defend itself against a megabyte. Channels with tighter limits of their own
 *  still chunk or refuse downstream. */
export const SEND_MESSAGE_MAX_LENGTH = 8000;

/**
 * Where a send is between the guardian pressing Send and the message appearing
 * on the timeline.
 *
 * - `sending` — handed to the channel, no answer yet.
 * - `unconfirmed` — the channel accepted it and named it, but it has not
 *   surfaced in the store the timeline reads. Normally under a second; a state
 *   at all because "we sent it and cannot see it" is a thing that happens and
 *   is worth saying rather than papering over.
 * - `failed` — the channel refused. The only state a guardian can act on, and
 *   the only one that persists without something else having gone wrong.
 */
export type OutboxState = "sending" | "unconfirmed" | "failed";

/**
 * One message Rome is still trying to deliver.
 *
 * Deliberately not a {@link TimelineEntry} with a status on it. A timeline
 * entry is a message that happened; these have not, and some never will. Two
 * nouns keep the timeline's contract — its `ref` uniqueness and the ordering
 * its cursor is written against — free of rows that may yet be withdrawn, and
 * keep each account owned by exactly one store.
 *
 * `ref` is the entry this message would become at the address it was sent to.
 * It is a hint and not a key: a channel that folds several addresses onto one
 * account may deliver under another of them, and then the landed entry carries
 * that address instead. Recognizing an arrival is the server's job, which is
 * why it enumerates every folded address and why a client must not dedupe the
 * timeline against this value — the row is gone from the outbox by the time
 * there is anything to dedupe against.
 */
export interface OutboxMessage {
  id: string;
  channel: string;
  channelUserId: string;
  text: string;
  /** Epoch seconds of the attempt, which is also the entry's timestamp once it
   *  lands. */
  timestamp: number;
  state: OutboxState;
  /** The entry this would become at the address it was sent to, or null while
   *  the channel has not named the message yet. A hint — see above. */
  ref: string | null;
  /** Why the channel refused, for a `failed` row. Provider text, shown as
   *  detail beneath copy the dashboard owns. */
  error: string | null;
}

/** `GET /api/people/:id/outbox` — every send of this person's that has not
 *  reached their timeline. Unpaged: an outbox with enough rows to page is an
 *  incident, not a listing. */
export interface OutboxPage {
  messages: OutboxMessage[];
}

/**
 * A send the server would not attempt, and which of the reasons it was.
 *
 * Carries the same {@link AccountSendState} the person read carries, so the
 * refusal renders as the copy the composer would already have shown had the
 * read been fresh. A client that raced a disconnect therefore says the same
 * thing either way instead of surfacing a bare 409.
 *
 * `error` is a fallback line, not the copy: the dashboard keys off `send`.
 */
export interface SendRefusal {
  error: string;
  send: Exclude<AccountSendState, "yes">;
}
