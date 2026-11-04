import {
  accountRef,
  ASSIGNABLE_BOND_LEVELS,
  BOND_LADDER,
  compareAccountCursors,
  matchesQuery,
  normalizeBondLevel,
  type AccountCounts,
  type BondLadderLevel,
  type DirectoryAccount,
  type PersonCounts,
  type PersonResource,
} from "@rome/api-types/people";
import { accountHandle } from "./send-model";

// The People page's derivations, kept out of the components so the directory
// groups and the counts can be exercised without rendering. Every one
// of them is a pure function of what the two reads returned plus the view's own
// controls.
//
// The contract is two nouns — a person (`GET /api/people`) and an account
// somebody is reachable at (`GET /api/accounts`) — and this page is one ladder
// over both. `PeopleRow` is that join: the shape a row renders from, whichever
// noun it came from. Everything channel-shaped about it — which addresses are
// one account, what the channel calls it — is the server's answer carried
// through, not a rule restated here.

/** Where a row sits on the ladder. The four placed levels are a person's stored
 *  bond; the two unplaced ends are what the guardian has not decided (an
 *  unlinked account) and what they decided against (a dismissed one). */
export type RowLevel = BondLadderLevel;

/** The chip the filter rail offers. "all" is a view, not a ladder position. */
export type PeopleFilter = "all" | RowLevel;

/**
 * The chips, in rail order.
 *
 * Guardian has none: it is the guardian's own row, which "All" shows at the
 * top rather than under a chip of its own. "All" holds back both unplaced
 * ends of the ladder too, so a queue and a dismissal are each entered on
 * purpose rather than sitting in the default view.
 *
 * Stranger comes last and the rail pushes it to the far end, because it is not
 * a peer of the chips before it: those name a bond the guardian has already
 * given, and Stranger is the queue of accounts still waiting for one.
 */
export const FILTER_ORDER: PeopleFilter[] = [
  "all",
  "inner-circle",
  "acquaintance",
  "other",
  "dismissed",
  "stranger",
];

/**
 * Where the page answers, and what the controls above it ride in the query.
 *
 * The chip and the term ride the query under the names the reads themselves
 * take — `level` and `q` — so a shared address reads as the request it
 * produces, a reload comes back to what was on screen, and back steps through
 * the choices that got there.
 */
export const PEOPLE_PATH = "/people/directory";
export const FILTER_PARAM = "level";
export const SEARCH_PARAM = "q";

/**
 * Where one person's dossier answers.
 *
 * Under its own segment, because a person id is a slug of the display name the
 * guardian gave them: `generatePersonSlug("Directory")` is `directory`. Sharing
 * the page's segment would leave a person named after it with no address that
 * reaches their dossier.
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
 * The address a chip and a term make together — every link this page builds,
 * from whichever of the two the guardian just moved.
 *
 * Defaults are left out, so the plain {@link PEOPLE_PATH} is what the page is
 * usually at and a query parameter means somebody chose something.
 */
export function peoplePath(controls: { filter: PeopleFilter; search: string }): string {
  const query = new URLSearchParams();
  if (controls.filter !== "all") query.set(FILTER_PARAM, controls.filter);
  if (controls.search) query.set(SEARCH_PARAM, controls.search);
  const suffix = query.toString();
  return suffix ? `${PEOPLE_PATH}?${suffix}` : PEOPLE_PATH;
}

/** Directory groups, in ladder order. */
export const GROUP_ORDER: RowLevel[] = [...BOND_LADDER];

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

/**
 * One row on the People page, from either noun.
 *
 * `kind` is what the row *is*, and it decides what can be done with it: only a
 * person has a page to open. `id` is the route id for a person and the
 * account's own `channel:channelUserId` ref otherwise — never mixed, so nothing
 * has to guess which read a row came from.
 */
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
  accounts: readonly DirectoryAccount[],
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
  }));

  for (const account of accounts) {
    if (account.state === "linked") continue;
    rows.push({
      kind: "account",
      id: accountRef(account),
      displayName: account.displayName,
      level: account.state === "dismissed" ? "dismissed" : "stranger",
      accounts: [
        {
          channel: account.channel,
          channelUserId: account.channelUserId,
          displayName: account.displayName,
        },
      ],
      addresses: account.addresses,
    });
  }

  return rows;
}

/** The guardian is not selectable and not movable —
 *  that is the one row the page's uniform treatment does not apply to. */
export function isRowFixed(row: PeopleRow): boolean {
  return row.level === "guardian";
}

/** The identifier a row is recognized by when its name is not enough, by the
 *  same rule as the person page's {@link accountHandle}. Null when that is the
 *  name itself, as for an agent the row names by its label. */
export function rowHandle(row: PeopleRow): string | null {
  const account = row.accounts[0];
  if (!account) return null;
  const handle = accountHandle(account);
  return handle === row.displayName ? null : handle;
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

export interface PeopleGroup {
  level: RowLevel;
  rows: PeopleRow[];
}

/**
 * The directory's groups, in ladder order, after the chip and the search box
 * have each had their say.
 *
 * "All" is the guardian's own row, then the people the guardian has placed:
 * the three assignable levels. The guardian's row leads because it is where
 * they read which accounts are theirs. The ladder's other positions each
 * answer a different question — Stranger is the accounts still waiting on a
 * decision, Dismissed is what was decided against — so each is entered on
 * purpose rather than padding the list somebody scrolls to look a contact up
 * in.
 *
 * A search still reaches every one of them, held-back positions included: a
 * roster that filtered the address book would answer "no such contact" for
 * someone the mirror has. Empty groups are dropped rather than rendered as
 * headings with nothing under them.
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
    if (searching) return true;
    return options.filter === "all"
      ? group.level === "guardian" ||
          (ASSIGNABLE_BOND_LEVELS as readonly RowLevel[]).includes(group.level)
      : group.level === options.filter;
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
 * What "stranger" counts is the account read's own answer: the whole contacts
 * list, so everyone Rome has not placed.
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
    dismissed: accounts.dismissed,
    stranger: accounts.unlinked,
  };
}
