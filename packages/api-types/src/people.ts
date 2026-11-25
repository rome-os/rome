// The People surface's contract, in two nouns — a person, and the accounts
// they are reachable at:
//
//   GET    /api/people              -> PeopleList (curated people only)
//   GET    /api/accounts            -> AccountDirectory
//   POST   /api/people/link-code    -> LinkCodeResponse
//
// The vocabulary is docs/concepts/people.md's. Rome never mints an account:
// an account is platform-owned, named by the pair (channel, channelUserId) —
// its platform and its own address. The field keeps the name `channel`, and a
// core that predates platform-keyed links sent the kind of connection in it.
// The only fact about who is who that
// Rome contributes is which person it belongs to.
//
// The bond ladder and the timeline paging (`TimelinePage`) live here; the
// assistants' routes page by it. What a timeline holds — the message shape,
// its order and its cursor — is the message module's (`./message.ts`), which
// this file imports.
//
// The account read is a contacts list: every account, ordered by name,
// carrying nothing about what anyone said — it is where a guardian looks
// someone up.

import type { Account } from "@rome-os/app-runtime";
import { compareCodePoints, type Message } from "./message.js";

// ---------------------------------------------------------------------------
// The bond ladder
// ---------------------------------------------------------------------------

/**
 * Every position on the bond ladder a surface renders, in display order.
 *
 * "stranger" and "dismissed" are positions on the same ladder as the curated
 * bonds, not separate kinds of thing, and neither is ever stored on a person:
 * they are the two states of an account nobody is behind
 * (docs/domains/people.md#account). A stranger has no link and no dismissal,
 * and a dismissed account has a dismissal. Both are read off the account.
 */
export const BOND_LADDER = [
  "stranger",
  "guardian",
  "inner-circle",
  "acquaintance",
  "other",
  "dismissed",
] as const;

export type BondLadderLevel = (typeof BOND_LADDER)[number];

/** A level a person row can actually hold: the ladder minus its two computed
 *  positions. */
export type PlacedBondLevel = Exclude<BondLadderLevel, "stranger" | "dismissed">;

/**
 * The levels a guardian may place a person at.
 *
 * Guardian is not one of them: the instance serves exactly one, and the
 * ladder's other two positions are read off the links rather than stored.
 */
export const ASSIGNABLE_BOND_LEVELS = ["inner-circle", "acquaintance", "other"] as const;

export type AssignableBondLevel = (typeof ASSIGNABLE_BOND_LEVELS)[number];

/**
 * Bucket a stored `persons.bondLevel` onto the ladder. The column is free text
 * and older rows carry values outside today's enum (e.g. "colleague"), so
 * every reader has to agree on where those land rather than dropping the row
 * from every group.
 */
export function normalizeBondLevel(raw: string): PlacedBondLevel {
  return (BOND_LADDER as readonly string[]).includes(raw) &&
    raw !== "stranger" &&
    raw !== "dismissed"
    ? (raw as PlacedBondLevel)
    : "other";
}

// ---------------------------------------------------------------------------
// Ordering and matching, defined the same way in every runtime
// ---------------------------------------------------------------------------

/**
 * The total string order the account and display-name orders settle their ties
 * with. Re-exported from the message module ({@link compareCodePoints}), which
 * owns it because the message cursor is written against it, so "how two strings
 * order for a cursor" has one definition here rather than a second that drifts.
 */
export { compareCodePoints };

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
 * order both ends agree on.
 */
export function compareDisplayNames(a: string, b: string): number {
  const normalizedA = a.normalize("NFC");
  const normalizedB = b.normalize("NFC");
  const byFolded = compareCodePoints(caseFold(normalizedA), caseFold(normalizedB));
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
  const q = caseFold(query.normalize("NFC").trim());
  if (!q) return true;
  return caseFold(haystack.join(" ").normalize("NFC")).includes(q);
}

/**
 * Unicode case folding, which JavaScript has no built-in for, shared by the
 * name orderings and search so they fold alike.
 *
 * Lowercasing alone misses the folds that expand or merge letters: "ß" and
 * "ẞ" are "ss", "ſ" is "s", "ﬁ" is "fi". Going through uppercase picks those
 * up, except for the dotless "ı", which folds to itself but would come back
 * as "i", so it stays out of the round trip. Then final sigma becomes the
 * medial one and Cherokee its uppercase, as folding does, and the result is
 * normalized again, since the round trip can decompose a letter.
 *
 * A directory sort folds every name on each comparison, so text that folds
 * exactly as it lowercases skips the round trip: printable ASCII, and the
 * caseless CJK punctuation, kana, ideographs and Hangul syllables most names
 * here are written in. That holds for NFC input, which both callers pass; a
 * decomposed kana voicing mark would otherwise stay apart from its letter.
 */
function caseFold(value: string): string {
  if (!/[^ -~\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/.test(value)) {
    return value.toLowerCase();
  }
  return value
    .toLowerCase()
    .split("ı")
    .map((part) => part.toUpperCase().toLowerCase())
    .join("ı")
    .replaceAll("ς", "σ")
    .replace(/[\u13f8-\u13fd\uab70-\uabbf]/g, (letter) => letter.toUpperCase())
    .normalize("NFC");
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
// An account's timeline
// ---------------------------------------------------------------------------
//
// What the timeline holds is a {@link Message}, and the order it is read in and
// the cursor that resumes it are the message module's ({@link compareMessages},
// {@link messageCursor}). Its paging is the People surface's own, stated below.

/** One page of an account's timeline, newest first. `nextCursor` is opaque and
 *  null once the oldest message has been sent. */
export interface TimelinePage {
  entries: Message[];
  nextCursor: string | null;
}

export const TIMELINE_PAGE_DEFAULT_LIMIT = 100;
export const TIMELINE_PAGE_MAX_LIMIT = 300;

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
 * What the guardian has decided about an account.
 *
 * "unlinked" is the absence of a decision rather than one Rome writes down: an
 * account it has observed and nobody has placed. The other two are decisions —
 * a link onto a person, and a dismissal, which says the account belongs to
 * nobody the guardian tracks and names no person.
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

/** What the guardian decided about an account: the person it is linked to,
 *  or that they dismissed it. */
export type AccountLink = { personId: string; displayName: string } | { dismissed: true };

/**
 * Read a link the way every surface has to read it. A dismissal answers a state
 * and no person: it is a decision about the account, and nobody is behind it.
 */
export function accountPresentation(link: AccountLink | null | undefined): AccountPresentation {
  if (link == null) return { state: "unlinked", personId: null, personName: null };
  if ("dismissed" in link) return { state: "dismissed", personId: null, personName: null };
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
 * anything to count.
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
  /** The linked person, or null when the account is a stranger or dismissed. */
  personId: string | null;
  personName: string | null;
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
   * Rome has not placed rather than the senders waiting on a decision.
   */
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
 *  else, and a person's name finds the accounts they were placed on.
 *
 *  The channel's name too, unless the caller has already fixed the channel:
 *  then every row shares it, and a term that happens to fall inside it
 *  ("mail", "ai") would answer every row instead of the ones it names. */
export function accountMatchesQuery(
  account: DirectoryAccount,
  query: string,
  options: { matchChannel?: boolean } = {},
): boolean {
  return matchesQuery(query, [
    account.displayName,
    account.personName ?? "",
    ...(options.matchChannel === false ? [] : [account.channel]),
    ...account.addresses,
  ]);
}

/**
 * Where one account sits in the directory's order: the name it is filed under,
 * and its ref to settle a tie.
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

/** Whether an account falls after a cursor in {@link compareAccountCursors} order —
 *  i.e. belongs on a later page than the one that cursor ended. */
export function isAfterAccountCursor(account: DirectoryAccount, cursor: AccountCursor): boolean {
  return compareAccountCursors(cursor, accountCursorOf(account)) < 0;
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
 * `query` and `channel` scope everything, including the counts — a listing
 * fixed to one channel is that channel's directory. `state` and the cursor scope
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
    channel?: string | null;
    state?: AccountState | null;
    cursor?: AccountCursor | null;
    limit?: number | null;
  } = {},
): AccountDirectory {
  const query = options.query?.trim() ?? "";
  const channel = options.channel || null;
  const onChannel = channel ? directory.filter((a) => a.channel === channel) : directory;
  const matching = query
    ? onChannel.filter((a) => accountMatchesQuery(a, query, { matchChannel: !channel }))
    : onChannel;

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
   * It decides which account a send defaults to ({@link defaultSendAccount}),
   * the one the guardian last heard from, and
   * only an account's own time can tell two accounts on one channel apart.
   */
  latestAt: number | null;
  /**
   * Rome's own accounts a send to this account may name as
   * as `from`: each account on its platform a connection
   * backs, oldest first. Asked when the person is read, never stored. Absent
   * from a core that predates it.
   */
  from?: Account[];
  /**
   * True on a delegate link (docs/domains/people.md#delegate-link): the account
   * is an agent's, acting for this person, so whoever reads it is talking to
   * their agent and not to them. Absent on the person's own accounts.
   */
  delegate?: true;
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
 * - `no-conversation` — the channel cannot identify a direct conversation for
 *   this account. This includes missing or ambiguous threads.
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
 * behalf. This only decides which of the offered accounts is filled in
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
 * A person with the accounts linked to them.
 *
 * `bondLevel` is the stored value, free text included: older rows carry levels
 * outside today's ladder ("colleague"), and a reader buckets them with
 * {@link normalizeBondLevel} rather than the contract pretending they cannot
 * exist.
 *
 * No activity beyond each account's `latestAt`: a person is not a history
 * joined across their accounts.
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
  memoryPath: string | null;
}

/**
 * `GET /api/people` — every curated person, and the numbers its filter chips
 * show.
 *
 * Unpaged, unlike the account directory: curated people are entered one at a
 * time by a guardian, so the listing is bounded by hand. The account directory
 * is a mirrored address book of thousands and pages.
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

/** A level the listing can be filtered and counted by: a bond level, or "all"
 *  — every curated person whatever their level. */
export type PersonFilterLevel = "all" | PlacedBondLevel;

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
 * The listing's order: by display name, ties broken by id so the sequence is
 * total. A person carries no activity to order by, since a history is one
 * account's.
 */
export function comparePeople(a: PersonResource, b: PersonResource): number {
  const byName = compareDisplayNames(a.displayName, b.displayName);
  return byName !== 0 ? byName : compareCodePoints(a.id, b.id);
}

/** A person as the people repository creates one: a name, a bond level, and
 *  the accounts linked to them. */
interface CreatePersonRequest {
  displayName: string;
  /** Defaults to "other". */
  bondLevel?: AssignableBondLevel;
  accounts?: { channel: string; channelUserId: string }[];
}

/** A create request with its defaults applied: what the write is given. */
export type NewPerson = Required<CreatePersonRequest>;

/**
 * `POST /api/people/link-code`: a code the guardian sends, in a direct message
 * from their own account, to any of Rome's accounts on any platform. Redeeming
 * it links that account to the guardian.
 * One code is outstanding at a time and it is used once.
 */
export interface LinkCodeResponse {
  code: string;
  /** Epoch milliseconds. */
  expiresAt: number;
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
function formatWhatsAppPhone(value: string | null | undefined): string | null {
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
// Sending
// ---------------------------------------------------------------------------

/**
 * A send answered: the channel took the message.
 *
 * Not a {@link Message}. The message joins the timeline once the store that
 * answers for its conversation holds it: Rome's own record, or on a channel
 * with a mirror, the mirror's copy, which may arrive after this answer.
 * Nothing here is to be deduped against it: `ref` names the entry it becomes
 * at the address it was sent to, and a channel that folds several addresses
 * onto one account may deliver under another of them.
 */
export interface SentMessage {
  /** The entry this becomes at the address it was sent to, or null when the
   *  channel named no message. */
  ref: string | null;
  /** Epoch seconds of the send. */
  timestamp: number;
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

/** The {@link SendRefusal} `error` line for each reason. A fallback, not the
 *  copy: the dashboard renders `send` through its own locale files. */
export function sendRefusalMessage(send: Exclude<AccountSendState, "yes">): string {
  switch (send) {
    case "not-connected":
      return "That channel is not connected";
    case "unsupported":
      return "Rome cannot send on that channel";
    case "no-conversation":
      return "Rome has no conversation open with that account";
  }
}
