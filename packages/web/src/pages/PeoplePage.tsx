import { useMemo } from "react";
import { Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { CircleAlert, RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useComposedInput } from "@/hooks/use-composed-input";
import { FilterChipGroup } from "@/components/ui/filter-chip-group";
import { List } from "@/components/ui/list-row";
import { PageShell, PageBody, PageHeader } from "@/shell/PageShell";
import { DirectoryRow, levelLabelKey } from "./people/rows";
import { DismissedEntry, StrangerEntry } from "./people/triage";
import { LinkMyAccount } from "./people/link-code";
import {
  directoryGroups,
  FILTER_ORDER,
  FILTER_PARAM,
  levelCounts,
  parsePeopleFilter,
  PEOPLE_PATH,
  peoplePath,
  personPath,
  SEARCH_PARAM,
  type LevelCounts,
  type PeopleFilter,
  type PeopleRow,
  type RowLevel,
} from "./people/people-model";
import { usePeopleRoster } from "./people/use-roster";

/**
 * The People page: a roster, over two reads.
 *
 * It answers "who does Rome know" — a contacts list, everyone Rome holds, by
 * name, with no preview and no count anywhere in it. Stranger and Dismissed are positions on
 * the same ladder as the curated levels, so an account waiting on a decision
 * and a person the guardian placed sit in one list rather than in sections that
 * cannot say where either stands relative to the other.
 *
 * The contract is two nouns and this page is one ladder over both: `GET
 * /api/people` for the people and `GET /api/accounts` for the accounts, joined
 * in `people-model.ts`. An account's history is a third read, `GET
 * /api/people/:id/messages`, and it belongs to the person page.
 *
 * Nothing here knows a channel. LinkedIn was the last one with a surface of its
 * own — a section below the roster, reading its own mirror, for as long as a
 * LinkedIn thread resolved to no person. It resolves now, so LinkedIn arrives
 * through the same two reads as everything else and is placed, dismissed and
 * opened by the same gestures. A channel added after this page was written
 * lands here the same way, without a section.
 *
 * The chip and the search term ride the query. The page holds no control
 * state of its own: what is on screen is what the address says, so a view is
 * linkable, a reload returns to it, and back steps through the choices that
 * got there.
 *
 * Every number on screen is the server's. The directory pages, so a count taken
 * over the rows that happened to arrive would report no waiting senders as soon
 * as placed people filled page one — and it is why a write settles by
 * invalidating these reads rather than by editing what they returned.
 */

/**
 * `/people`, and `/people/latest` where an activity view once was, forward to
 * the roster, carrying whatever chip and term the link arrived with, so an
 * address written before still lands somewhere.
 */
export function PeopleIndexRedirect() {
  const { search } = useLocation();
  return <Navigate to={{ pathname: PEOPLE_PATH, search }} replace />;
}

export default function PeoplePage() {
  const { t } = useTranslation("people");
  const { t: tCommon } = useTranslation("common");
  const navigate = useNavigate();

  // Every control on this page is in the address: the chip and the term in the
  // query. So each moves by navigating,
  // and each reads back out of the URL rather than out of a second copy that
  // could disagree with it.
  const [params] = useSearchParams();
  const filter = parsePeopleFilter(params.get(FILTER_PARAM));
  const search = params.get(SEARCH_PARAM) ?? "";

  // A chip is one deliberate choice and gets a history entry, so back
  // undoes it. Typing does not: a term reached by keystroke would otherwise
  // leave one entry per letter between the guardian and the page they came
  // from.
  const go = (next: { filter?: PeopleFilter; search?: string }, options?: { replace?: boolean }) =>
    navigate(peoplePath({ filter: next.filter ?? filter, search: next.search ?? search }), options);

  const searchInput = useComposedInput(search, (next) => go({ search: next }, { replace: true }));

  // The roster renders every group at once, so the chip rides neither read — a
  // level on the request would leave the other headings with nothing to show.
  const roster = usePeopleRoster({ search });
  const rows = roster.rows;

  // Derived from the term the loaded rows answer, not the one in the box: the
  // box runs ahead of the request by a debounce, and filtering this page by a
  // term it was not fetched for empties it for exactly the contacts only the
  // server's search can reach.
  const settled = roster.settledSearch;
  const groups = useMemo(
    () => directoryGroups(rows, { filter, search: settled }),
    [rows, filter, settled],
  );
  // The numbers the chips and the group headings show. Stranger is everyone
  // Rome has not placed.
  const counts = useMemo(
    () => levelCounts(roster.peopleCounts, roster.accountCounts),
    [roster.peopleCounts, roster.accountCounts],
  );
  // A link lands on a person, so the picker offers the people this read
  // returned rather than the accounts beside them.
  const linkTargets = useMemo(
    () =>
      rows
        .filter((row) => row.kind === "person" && row.level !== "guardian")
        .map((row) => ({ id: row.id, displayName: row.displayName, bondLevel: row.level })),
    [rows],
  );

  // Only a person has a page. An account nobody has placed carries its
  // gestures on its own row instead.
  //
  // The address being left goes with it, so the page's back link returns to
  // this chip and this term rather than to whichever entry happens to sit
  // behind it.
  const openRow = (row: PeopleRow) => {
    if (row.kind !== "person") return;
    navigate(personPath(row.id), { state: { from: peoplePath({ filter, search }) } });
  };

  const loading = roster.isPending;
  const loadError = roster.error ? roster.error.message : null;

  // Both unplaced ends of the ladder carry the gesture their position admits,
  // as the contacts line every other row is, with the gestures behind a `⋯`
  // menu at the end of it.
  const unplaced = (row: PeopleRow) =>
    row.level === "dismissed" ? (
      <DismissedEntry key={row.id} row={row} />
    ) : (
      <StrangerEntry key={row.id} row={row} people={linkTargets} />
    );

  return (
    <PageShell>
      <PageBody>
        <PageHeader title={tCommon("nav.people")} actions={<LinkMyAccount />} />

        <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
          <Input
            type="search"
            {...searchInput}
            placeholder={t("search.placeholder")}
            aria-label={t("search.label")}
            className="w-full sm:w-72"
          />
          <FilterChipGroup<PeopleFilter>
            aria-label={t("filters.groupLabel")}
            value={filter}
            onValueChange={(next) => go({ filter: next })}
            className="flex-1"
            options={FILTER_ORDER.map((option) => ({
              value: option,
              label: option === "all" ? t("filters.all") : t(levelLabelKey(option)),
              // Stranger is the page's one number that asks for a decision, so
              // it carries a count; the other chips are plain labels. It sits
              // at the far end for the same reason: the chips before it are
              // bonds the guardian has given, and this is what is still
              // waiting on them.
              count: option === "stranger" && counts.stranger > 0 ? counts.stranger : undefined,
              alignEnd: option === "stranger",
            }))}
          />
        </div>

        {/* A read that failed while rows are on screen: say so instead of
            leaving stale content passing for live. `keepPreviousData` holds the
            previous page through a refetch, which is what stops the list
            blanking on every keystroke — and would otherwise let a failed
            search or chip swallow its error, because the branch below only
            reports one when there is nothing to show. */}
        {loadError && rows.length > 0 && (
          <p className="flex flex-wrap items-center justify-center gap-2 rounded-8 bg-destructive-bg px-4 py-1 text-center text-aux text-destructive-fg">
            {loadError}
            <button
              type="button"
              onClick={() => void roster.refetch()}
              className="underline underline-offset-2 hover:no-underline"
            >
              {t("errors.retry")}
            </button>
          </p>
        )}

        {loading && rows.length === 0 ? (
          <p className="py-12 text-center text-ui text-muted-foreground">{t("page.loading")}</p>
        ) : loadError && rows.length === 0 ? (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>{t("errors.loadFailedTitle")}</AlertTitle>
            <AlertDescription>
              <p>{loadError}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => void roster.refetch()}
              >
                <RefreshCw data-icon="inline-start" aria-hidden="true" />
                {t("errors.retry")}
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <DirectoryView
            groups={groups}
            counts={counts}
            searching={settled !== ""}
            onOpen={openRow}
            renderUnplaced={unplaced}
          />
        )}

        {roster.hasNextPage && (
          <div className="flex justify-center pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={roster.isFetchingNextPage}
              onClick={() => void roster.fetchNextPage()}
            >
              {t("page.loadMore")}
            </Button>
          </div>
        )}
      </PageBody>
    </PageShell>
  );
}

function DirectoryView({
  groups,
  counts,
  searching,
  onOpen,
  renderUnplaced,
}: {
  groups: { level: RowLevel; rows: PeopleRow[] }[];
  counts: LevelCounts;
  searching: boolean;
  onOpen: (row: PeopleRow) => void;
  renderUnplaced: (row: PeopleRow) => React.ReactNode;
}) {
  const { t } = useTranslation("people");
  // An empty roster is not a failed search. A chip whose level nobody sits at
  // empties this view with the box untouched, and All does it on an instance
  // where nobody has been placed yet.
  if (groups.length === 0) {
    return (
      <div className="rounded-12 border border-dashed border-border-strong bg-surface/50 py-10 text-center">
        <p className="text-ui text-muted-foreground">
          {searching ? t("page.emptyForSearch") : t("page.emptyDirectory")}
        </p>
      </div>
    );
  }

  return (
    <>
      {groups.map((group) => (
        <section key={group.level}>
          <div className="flex flex-wrap items-baseline gap-2 border-b border-border pb-1">
            <h2 className="text-section uppercase tracking-wide text-muted-foreground">
              {t(levelLabelKey(group.level))}
            </h2>
            {/* The server's total for the level, not the rows on screen: the
                directory pages, and a heading that counted what had loaded
                would read as a roster that shrank. */}
            <span className="font-mono text-badge tabular-nums text-subtle-foreground">
              {counts[group.level]}
            </span>
          </div>
          <List>
            {group.rows.map((row) =>
              row.kind === "account" ? (
                renderUnplaced(row)
              ) : (
                <DirectoryRow key={row.id} row={row} onOpen={() => onOpen(row)} />
              ),
            )}
          </List>
        </section>
      ))}
    </>
  );
}
