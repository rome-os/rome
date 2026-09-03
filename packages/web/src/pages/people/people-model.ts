import {
  accountRef,
  BOND_LADDER,
  compareAccountCursors,
  compareStreamCursors,
  formatWhatsAppPhone,
  matchesQuery,
  normalizeBondLevel,
  type AccountCounts,
  type AccountDynamic,
  type BondLadderLevel,
  type DirectoryAccount,
  type PersonCounts,
  type PersonResource,
  type StreamAccount,
} from "@rome/api-types/people";

// The People page's derivations, kept out of the components so the stream, the
// directory groups and the counts can be exercised without rendering. Every one
// of them is a pure function of what the two reads returned plus the view's own
// controls.
//
// The contract is two nouns — a person (`GET /api/people`) and an account
// somebody is reachable at (`GET /api/accounts`) — and this page is one ladder
// over both. `PeopleRow` is that join: the shape a row renders from, whichever
// noun it came from. Everything channel-shaped about it — which addresses are
// one account, what the channel calls it, how much is on record — is the
// server's answer carried through, not a rule restated here.

/** The two views the page offers: the activity stream, and the roster. */
export type PeopleView = "latest" | "directory";

/** Where a row sits on the ladder. The four placed levels are a person's stored
 *  bond; the two unplaced ends are what the guardian has not decided (an
 *  unlinked account) and what they decided against (a dismissed one). */
export type RowLevel = BondLadderLevel;

/** The chip the filter rail offers. "all" is a view, not a ladder position. */
export type PeopleFilter = "all" | RowLevel;

/**
 * The chips, in rail order.
 *
 * Guardian has none: it is the guardian's own row, which the directory always
 * shows and the stream never does. "All" holds back Stranger, so the dismissed
 * end of the ladder is entered on purpose rather than sitting in the default
 * view.
 */
export const FILTER_ORDER: PeopleFilter[] = [
  "all",
  "unknown",
  "inner-circle",
  "acquaintance",
  "other",
  "stranger",
];

/**
 * Where each view answers, and what the controls above it ride in the query.
 *
 * The view is the route rather than a piece of component state, so a directory
 * is something to link to, the back button steps between the two, and a reload
 * comes back to what was on screen. The chip and the term ride the query under
 * the names the reads themselves take — `level` and `q` — so a shared address
 * reads as the request it produces.
 */
export const PEOPLE_VIEW_PATH: Record<PeopleView, string> = {
  latest: "/people/latest",
  directory: "/people/directory",
};
export const FILTER_PARAM = "level";
export const SEARCH_PARAM = "q";

/**
 * Where one person's dossier answers.
 *
 * Under its own segment, because a person id is a slug of the display name the
 * guardian gave them: `generatePersonSlug("Latest")` is `latest`. Sharing the
 * views' segment would leave a person named after one of them with no address
 * that reaches their dossier.
 */
export function personPath(personId: string): string {
  return `/people/person/${encodeURIComponent(personId)}`;
}

/**
 * The chip a URL asks for, or "all" when it names none the rail offers.
 *
 * An address is typed, kept and shared, so it will eventually name a level the
 * rail has stopped offering. Falling back leaves the page on its default view
 * rather than with a rail where nothing is selected.
 */
export function parsePeopleFilter(raw: string | null | undefined): PeopleFilter {
  return FILTER_ORDER.includes(raw as PeopleFilter) ? (raw as PeopleFilter) : "all";
}

/**
 * The address a view, a chip and a term make together — every link this page
 * builds, from whichever one of the three the guardian just moved.
 *
 * Defaults are left out, so the plain `/people/latest` is what the page is
 * usually at and a query parameter means somebody chose something.
 */
export function peoplePath(
  view: PeopleView,
  controls: { filter: PeopleFilter; search: string },
): string {
  const query = new URLSearchParams();
  if (controls.filter !== "all") query.set(FILTER_PARAM, controls.filter);
  if (controls.search) query.set(SEARCH_PARAM, controls.search);
  const suffix = query.toString();
  return suffix ? `${PEOPLE_VIEW_PATH[view]}?${suffix}` : PEOPLE_VIEW_PATH[view];
}

/** Directory groups, in ladder order. */
export const GROUP_ORDER: RowLevel[] = [...BOND_LADDER];

/**
 * One row on the People page, from either noun.
 *
 * `kind` is what the row *is*, and it decides what can be done with it: only a
 * person has a dossier to open, because only a person has a merged history to
 * open it on. `id` is the route id for a person and the account's own
 * `channel:channelUserId` ref otherwise — never mixed, so nothing has to guess
 * which read a row came from.
 */
/**
 * A person a link can land on, as the picker needs them.
 *
 * Not a `PersonResource`: the picker names an option and ranks it by bond, and
 * knows nothing about how the person is reachable. Rebuilding the full resource
 * from a listing row meant inventing the fields the row does not carry, which
 * is how a picker ends up asserting a person cannot be written to.
 */
export interface LinkTarget {
  id: string;
  displayName: string;
  bondLevel: string;
}

export interface PeopleRow {
  kind: "person" | "account";
  id: string;
  displayName: string;
  level: RowLevel;
  /** Every account the row stands for: a person's linked accounts, or the one
   *  account itself. */
  accounts: { channel: string; channelUserId: string; displayName: string }[];
  /**
   * Every address the row can be reached at, the server's fold of them.
   *
   * A WhatsApp contact answers to both its phone jid and its `@lid` jid; which
   * of those are one account is the channel's answer, given once by the server
   * in `DirectoryAccount.addresses`. The client renders what it decided rather
   * than folding a second time and disagreeing.
   */
  addresses: string[];
  /**
   * The row's newest dynamic, or null when there is none — and null on every
   * account row the directory read produced, which carries no activity at all.
   * Only the stream renders it.
   */
  latest: AccountDynamic | null;
  /**
   * How much is on record for the row. Zero on every account row: a person's
   * count is the length of the timeline their dossier pages, and neither
   * account read answers that question — the directory carries no activity at
   * all, and the stream carries a preview and nothing beside it.
   */
  messageCount: number;
}

/**
 * What a row says about activity, from whichever account read produced it.
 *
 * The directory is a contacts list and its rows carry nothing about what anyone
 * said, so a row built from one reports none. A stream row is the other way
 * round: it has a dynamic, which is why it is on the stream at all.
 */
function accountActivity(
  account: DirectoryAccount | StreamAccount,
): Pick<PeopleRow, "latest" | "messageCount"> {
  return { latest: "latest" in account ? account.latest : null, messageCount: 0 };
}

/**
 * The two reads, joined into one roster.
 *
 * A linked account is left out: it is the same human as the person it resolves
 * to, seen from the other side, and rendering both would put one person on the
 * page twice — with the bond on one row and the history on the other. The
 * person carries both, so the person is the row.
 */
export function peopleRows(
  people: readonly PersonResource[],
  accounts: readonly (DirectoryAccount | StreamAccount)[],
): PeopleRow[] {
  const rows: PeopleRow[] = people.map((person) => ({
    kind: "person",
    id: person.id,
    displayName: person.displayName,
    // The stored value is free text — older rows carry levels off today's
    // ladder — so it is bucketed here rather than trusted or dropped.
    level: normalizeBondLevel(person.bondLevel),
    accounts: person.accounts,
    addresses: person.accounts.map((account) => account.channelUserId),
    latest: person.latest,
    messageCount: person.messageCount,
  }));

  for (const account of accounts) {
    if (account.state === "linked") continue;
    rows.push({
      kind: "account",
      id: accountRef(account),
      displayName: account.displayName,
      level: account.state === "dismissed" ? "stranger" : "unknown",
      accounts: [
        {
          channel: account.channel,
          channelUserId: account.channelUserId,
          displayName: account.displayName,
        },
      ],
      addresses: account.addresses,
      ...accountActivity(account),
    });
  }

  return rows;
}

/** The guardian is not a routing decision, not selectable and not movable —
 *  that is the one row the page's uniform treatment does not apply to. */
export function isRowFixed(row: PeopleRow): boolean {
  return row.level === "guardian";
}

/** The identifier a row is recognized by when its name is not enough: a phone
 *  number where the channel has one, otherwise the raw handle. */
export function rowHandle(row: PeopleRow): string | null {
  const account = row.accounts[0];
  if (!account) return null;
  return account.channel === "whatsapp"
    ? (formatWhatsAppPhone(account.channelUserId) ?? account.channelUserId)
    : account.channelUserId;
}

/** What the search box matches over the rows already loaded: the name, and
 *  every address the row is reachable at — so a phone number finds a contact
 *  the platform named something else. The server matches the same fields; this
 *  is the client's copy of that rule over the page it holds. */
export function rowMatchesQuery(row: PeopleRow, query: string): boolean {
  return matchesQuery(query, [
    row.displayName,
    ...row.accounts.map((account) => account.channel),
    ...row.addresses,
  ]);
}

export function searchRows(rows: readonly PeopleRow[], query: string): PeopleRow[] {
  const q = query.trim();
  if (!q) return [...rows];
  return rows.filter((row) => rowMatchesQuery(row, q));
}

/** The stream's order: newest first, rows that have never done anything last,
 *  ties broken by name and then id so the sequence is total. The account
 *  stream's order rather than a second one that happens to agree. */
export function compareRows(a: PeopleRow, b: PeopleRow): number {
  return compareStreamCursors(
    { timestamp: a.latest?.timestamp ?? null, displayName: a.displayName, id: a.id },
    { timestamp: b.latest?.timestamp ?? null, displayName: b.displayName, id: b.id },
  );
}

/**
 * The directory's order, within a group: by display name, ties broken by id so
 * the sequence is total.
 *
 * The account contract's own directory order, which is what the server pages
 * by. A second ordering that happened to agree would disagree at a page
 * boundary, and the guardian would read one contact twice.
 */
export function compareRowsByName(a: PeopleRow, b: PeopleRow): number {
  return compareAccountCursors(
    { displayName: a.displayName, ref: a.id },
    { displayName: b.displayName, ref: b.id },
  );
}

/** Whether a row belongs to a chip's view. "all" is the placed levels: the two
 *  unplaced ends of the ladder are both entered on purpose, so neither an
 *  account waiting on a decision nor one already dismissed is the default. */
export function rowMatchesFilter(row: PeopleRow, filter: PeopleFilter): boolean {
  return filter === "all"
    ? row.level !== "unknown" && row.level !== "stranger"
    : row.level === filter;
}

/**
 * The stream: one row per account that has a dynamic, newest first, over both
 * nouns at once.
 *
 * The reader is asking who has something new, and whether Rome has placed the
 * sender is not part of that question — so a waiting sender and a curated
 * person interleave by time rather than sitting in separate sections.
 *
 * The chip picks which of the two nouns the view is about, so it is applied
 * here as well as ridden by the request: the account directory pages, and the
 * request can only narrow it by state, while "which level of person" is the
 * people read's own parameter. Both ends narrow the same set, and this is the
 * one that holds for both nouns at once.
 *
 * A search takes over from the chip — someone typing a name wants that person
 * wherever they sit — and reaches quiet contacts, so the roster is reachable
 * from the same box.
 */
export function streamRows(
  rows: readonly PeopleRow[],
  options: { search: string; filter: PeopleFilter },
): PeopleRow[] {
  if (options.search.trim() !== "") {
    return searchRows(rows, options.search)
      .filter((row) => !isRowFixed(row))
      .sort(compareRows);
  }
  return rows
    .filter(
      (row) => row.latest !== null && !isRowFixed(row) && rowMatchesFilter(row, options.filter),
    )
    .sort(compareRows);
}

export interface PeopleGroup {
  level: RowLevel;
  rows: PeopleRow[];
}

/**
 * The directory's groups, in ladder order, after the chip and the search box
 * have each had their say.
 *
 * Every contact Rome holds is in here: a contacts app hides nobody, and a
 * roster that held the address book back would answer "no such contact" for
 * someone the mirror has.
 *
 * Guardian survives every filter: a roster that hid it would read as "you are
 * not in your own people list". Empty groups are dropped rather than rendered
 * as headings with nothing under them.
 */
export function directoryGroups(
  rows: readonly PeopleRow[],
  options: { filter: PeopleFilter; search: string },
): PeopleGroup[] {
  const searching = options.search.trim() !== "";
  const matching = searchRows(rows, options.search);

  return GROUP_ORDER.map((level) => ({
    level,
    rows: matching.filter((row) => row.level === level).sort(compareRowsByName),
  })).filter((group) => {
    if (group.rows.length === 0) return false;
    if (searching || group.level === "guardian") return true;
    return options.filter === "all" ? group.level !== "stranger" : group.level === options.filter;
  });
}

/** How many rows sit at each ladder position, over the whole roster the query
 *  admits rather than the page that arrived. */
export type LevelCounts = Record<RowLevel, number>;

/**
 * How many rows sit at each ladder position, from both reads at once.
 *
 * Off the reads rather than the loaded rows. The account read pages, so a tally
 * over what happened to arrive would report no waiting senders whenever placed
 * people filled page one.
 *
 * What "unknown" counts is the account read's own answer, and the two views
 * hand this different ones on purpose: the directory's read is the whole
 * contacts list, so it counts everyone Rome has not placed, while the stream's
 * is the accounts something has happened on, so it counts the senders actually
 * waiting on a decision. Each number describes the listing the reader is
 * looking at.
 *
 * A linked account is never counted twice: it is already counted under the
 * person it resolves to, which is the same rule that keeps it off the roster as
 * a row of its own.
 */
export function levelCounts(people: PersonCounts, accounts: AccountCounts): LevelCounts {
  return {
    guardian: people.guardian,
    "inner-circle": people["inner-circle"],
    acquaintance: people.acquaintance,
    other: people.other,
    stranger: accounts.dismissed,
    unknown: accounts.unlinked,
  };
}
