import { useEffect, useRef, useState } from "react";
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type {
  AccountDirectory,
  AccountState,
  AccountStream,
  OutboxPage,
  PeopleList,
  PersonResource,
  TimelinePage,
} from "@rome/api-types/people";
import { getApiErrorMessage } from "@/lib/api-error";
import { fetchJson } from "@/lib/fetch-json";
import { peopleRows, type PeopleRow, type PeopleView } from "./people-model";

// The People page's reads, and nothing else — the writes are `./writes.ts`,
// and `./use-writes.ts` is what settles these queries after one lands.
//
// Named for the roster rather than for people: `@/hooks/use-people` is the one
// shared people cache the composer's mention list reads, and these are this
// page's own paged reads. Two hooks with one name would be read as one.
//
// Two reads compose the roster: `GET /api/people` for the people the guardian
// has placed, and one of the two account reads for the accounts beside them.
// They are separate queries rather than one, because they page differently:
// curated people are entered one at a time by hand and the listing is bounded,
// while a synced address book is thousands of rows and pages by cursor.
//
// Which account read is the view's own question. The directory is a contacts
// list and reads `GET /api/accounts`: every account, by name, carrying nothing
// about what anyone said. The stream is the recents surface and reads `GET
// /api/accounts/stream`: what happened last, with the line to preview. Neither
// view pays for the other's fields, and a cursor from one never resumes the
// other — they are different orders.
//
// Every number a chip or a heading shows comes back with these reads and
// describes the whole roster the query admits. A tally over the rows that
// happened to arrive would report no waiting senders whenever placed people
// filled page one.

// The roots every query here is keyed under, exported so a write can invalidate
// them by prefix rather than restating the variants each read is cached in —
// which is what makes settling a write independent of how many chips, terms and
// pages happen to be cached at the time.
export const PEOPLE_KEY = "people";
export const ACCOUNTS_KEY = "accounts";
export const TIMELINE_KEY = "person-timeline";
export const OUTBOX_KEY = "person-outbox";

const ROSTER_POLL_MS = 30_000;

// How often the outbox is re-read while Rome is still trying to deliver
// something. Only while: a row that has failed is waiting on the guardian, not
// on the server, and an outbox with nothing in flight is a read that would
// answer the same thing forever.
const OUTBOX_POLL_MS = 1_000;

// How long the search box settles before its term reaches the wire. Long enough
// that a typed word is one request rather than one per letter, short enough
// that the pause is not read as the page having stopped.
const SEARCH_DEBOUNCE_MS = 250;

/** A value that only changes once it has held still for `delayMs`. */
function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

export interface PeopleRosterParams {
  search: string;
  /** Which account read the view is about — the contacts list, or the recents
   *  surface. */
  view: PeopleView;
  /**
   * Which state of account the view is about, when one narrows it.
   *
   * Sent to the endpoint rather than applied to the rows: the directory pages,
   * and a chip that filtered the rows already loaded would show only the
   * matches that happened to land on page one. Null asks for every state at
   * once, which is what the directory view renders.
   */
  accountState?: AccountState | null;
  /**
   * Which bond level the view is about, on the people read's own parameter.
   * Null asks for every level — the directory renders each as its own group,
   * and a level on the request would leave the other headings with nothing.
   */
  personLevel?: string | null;
}

/**
 * The roster: both reads, joined into one list of rows.
 *
 * The search term rides both query keys, so what the page shows is the server's
 * answer for the box rather than a filter over whichever page arrived first.
 * `keepPreviousData` holds the previous answer on screen while the next one
 * loads — which is what stops the list blanking on every keystroke, and is why
 * callers filter by {@link PeopleRoster.settledSearch} rather than by what is
 * in the box.
 */
export function usePeopleRoster(params: PeopleRosterParams) {
  const { t } = useTranslation("people");
  const fallback = t("errors.loadFailedFallback");
  // Only the typed term waits. A chip or a toggle is one deliberate click and
  // answers at once.
  const search = useDebounced(params.search.trim(), SEARCH_DEBOUNCE_MS);

  // A search takes over from the chip: someone typing a name wants that person
  // wherever they sit on the ladder. Both halves move off the one settled term,
  // so the level is dropped in step with the request that carries it rather
  // than a debounce ahead of it.
  const personLevel = search ? null : (params.personLevel ?? null);
  const accountState = search ? null : (params.accountState ?? null);

  const people = useQuery<PeopleList>({
    queryKey: [PEOPLE_KEY, search, personLevel],
    refetchInterval: ROSTER_POLL_MS,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => {
      const query = new URLSearchParams();
      if (search) query.set("q", search);
      if (personLevel) query.set("level", personLevel);
      const suffix = query.toString();
      return fetchJson<PeopleList>(`/api/people${suffix ? `?${suffix}` : ""}`, {
        signal,
        fallback,
      });
    },
  });

  // The account read pages; the people listing does not. Its cursor is opaque
  // and names a position rather than a row, so a page boundary survives an
  // account being linked or dismissed between two requests.
  //
  // The view is part of the key, not just of the URL: the two reads are two
  // orders with two cursors, and a page of one is not a page of the other.
  const path = params.view === "directory" ? "/api/accounts" : "/api/accounts/stream";
  const accounts = useInfiniteQuery<AccountDirectory | AccountStream>({
    queryKey: [ACCOUNTS_KEY, params.view, search, accountState],
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: ROSTER_POLL_MS,
    placeholderData: keepPreviousData,
    queryFn: ({ signal, pageParam }) => {
      const query = new URLSearchParams();
      if (search) query.set("q", search);
      if (accountState) query.set("state", accountState);
      if (pageParam) query.set("cursor", String(pageParam));
      const suffix = query.toString();
      return fetchJson<AccountDirectory | AccountStream>(`${path}${suffix ? `?${suffix}` : ""}`, {
        signal,
        fallback,
      });
    },
  });

  const accountPages = accounts.data?.pages ?? [];
  // Counts are whole-directory answers, identical on every page of one query;
  // the first page that arrived carries them.
  const head = accountPages[0];
  const rows: PeopleRow[] = peopleRows(
    people.data?.people ?? [],
    accountPages.flatMap((page) => page.accounts),
  );

  return {
    rows,
    /** The per-level numbers the chips and the group headings show. */
    peopleCounts: people.data?.counts ?? {
      all: 0,
      guardian: 0,
      "inner-circle": 0,
      acquaintance: 0,
      other: 0,
    },
    accountCounts: head?.counts ?? { unlinked: 0, linked: 0, dismissed: 0 },
    /** The term these rows answer. A caller filtering or labelling them reads
     *  this rather than what is in the box, or it applies a term the rows were
     *  not fetched for and empties the view for exactly the quiet contacts only
     *  the server's search can reach. */
    settledSearch: search,
    isPending: people.isPending || accounts.isPending,
    error: (people.error ?? accounts.error) as Error | null,
    hasNextPage: accounts.hasNextPage,
    isFetchingNextPage: accounts.isFetchingNextPage,
    fetchNextPage: accounts.fetchNextPage,
    refetch: async () => {
      await Promise.all([people.refetch(), accounts.refetch()]);
    },
  };
}

export type PeopleRoster = ReturnType<typeof usePeopleRoster>;

/**
 * The accounts a picker can name, as the server answers the term typed.
 *
 * The contacts list, so every account Rome has observed is offerable — and
 * every state, not only the unlinked ones. A picker that hid the accounts
 * another person already holds would hide the one gesture that can take one
 * back, and the contract answers that attempt with a conflict the caller
 * surfaces rather than with a silent re-point.
 *
 * Server-side, because the directory is an address book rather than a curated
 * listing: a filter over the page that happened to load would answer "no such
 * account" for a contact the mirror holds.
 */
export function useAccountSearch(search: string, options: { enabled: boolean }) {
  const { t } = useTranslation("people");
  const fallback = t("errors.loadFailedFallback");
  const term = useDebounced(search.trim(), SEARCH_DEBOUNCE_MS);
  return useQuery<AccountDirectory>({
    queryKey: [ACCOUNTS_KEY, "picker", term],
    enabled: options.enabled,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => {
      const query = new URLSearchParams();
      if (term) query.set("q", term);
      const suffix = query.toString();
      return fetchJson<AccountDirectory>(`/api/accounts${suffix ? `?${suffix}` : ""}`, {
        signal,
        fallback,
      });
    },
  });
}

/**
 * One person by id — what lets the dossier open a person the roster has not
 * paged to.
 *
 * A 404 answers null rather than throwing: "there is no such person" and "the
 * read failed" are different answers, and both would otherwise leave `data`
 * undefined. Reporting a network error as "merged away" tells the reader a
 * write landed when nothing was even read, and offers no way to try again.
 */
export function usePerson(id: string | undefined) {
  const { t } = useTranslation("people");
  const fallback = t("errors.loadFailedFallback");
  return useQuery<PersonResource | null>({
    queryKey: [PEOPLE_KEY, "one", id],
    enabled: id != null,
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/people/${encodeURIComponent(id!)}`, {
        signal,
        credentials: "include",
        cache: "no-store",
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(await getApiErrorMessage(response, fallback));
      return (await response.json()) as PersonResource;
    },
  });
}

/**
 * One person's history across every account they hold, newest first.
 *
 * One request rather than one per channel: which stores a history is merged
 * from is the server's business, and a client that merged per-channel reads
 * would have to re-derive the ordering the cursor is written against — and
 * would disagree with it at every page boundary.
 *
 * No interval. The dossier's writes converge on their own: `./use-writes.ts`
 * invalidates this key the moment one lands, so a merge or a link shows its new
 * history without waiting for a tick. The composer is the one write still to
 * come, and it settles the same way. What is left for a poll to catch is a
 * message arriving while the page sits open, which the client's
 * `refetchOnWindowFocus` already catches at the moment the reader looks back at
 * it — and a refetch here re-reads every page the reader has opened, so an
 * interval charges the deepest reader the most for the least.
 */
export function usePersonTimeline(id: string | undefined) {
  const { t } = useTranslation("people");
  const query = useInfiniteQuery<TimelinePage>({
    queryKey: [TIMELINE_KEY, id],
    enabled: id != null,
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    queryFn: ({ signal, pageParam }) => {
      // The cursor names an exact entry (time, direction, source, ref), so it
      // carries separators of its own and has to be escaped rather than pasted
      // into the query string.
      const search = pageParam ? `?cursor=${encodeURIComponent(String(pageParam))}` : "";
      return fetchJson<TimelinePage>(`/api/people/${encodeURIComponent(id!)}/messages${search}`, {
        signal,
        fallback: t("errors.loadFailedFallback"),
      });
    },
  });
  return { ...query, entries: query.data?.pages.flatMap((page) => page.entries) ?? [] };
}

/**
 * One person's outbox: every send of theirs that has not reached their
 * timeline.
 *
 * A row leaves this read by arriving, and the read is what notices — the server
 * derives the listing by comparing its sends against the timeline, so there is
 * no delivery to track here and nothing for a client to mark. That is why this
 * polls rather than settling once: the send returns before the message lands,
 * and the landing is a later answer to the same question.
 *
 * Only while something is in flight. A `failed` row waits on the guardian, and
 * an outbox with nothing being attempted would answer the same thing forever.
 *
 * The timeline is invalidated when a row disappears, because that is the same
 * event: a send Rome has stopped waiting on is a message the timeline now
 * holds, and the person's own `latest` and count moved with it.
 */
export function usePersonOutbox(id: string | undefined) {
  const { t } = useTranslation("people");
  const queryClient = useQueryClient();
  const query = useQuery<OutboxPage>({
    queryKey: [OUTBOX_KEY, id],
    enabled: id != null,
    refetchInterval: ({ state }) =>
      (state.data?.messages ?? []).some((message) => message.state !== "failed")
        ? OUTBOX_POLL_MS
        : false,
    queryFn: ({ signal }) =>
      fetchJson<OutboxPage>(`/api/people/${encodeURIComponent(id!)}/outbox`, {
        signal,
        fallback: t("errors.loadFailedFallback"),
      }),
  });

  // Which rows this reader last saw Rome still trying to deliver. A discard
  // takes a row out too, and settles the reads itself; this only has to catch
  // the rows that left because they arrived.
  const inFlight = useRef<string[]>([]);
  const messages = query.data?.messages;
  useEffect(() => {
    if (messages === undefined) return;
    const present = new Set(messages.map((message) => message.id));
    const landed = inFlight.current.some((messageId) => !present.has(messageId));
    inFlight.current = messages
      .filter((message) => message.state !== "failed")
      .map((message) => message.id);
    if (!landed) return;
    void queryClient.invalidateQueries({ queryKey: [TIMELINE_KEY, id] });
    void queryClient.invalidateQueries({ queryKey: [PEOPLE_KEY] });
  }, [messages, queryClient, id]);

  return { ...query, messages: messages ?? [] };
}
