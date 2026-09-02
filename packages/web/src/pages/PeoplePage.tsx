import { useMemo } from "react";
import { Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { CircleAlert, RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FilterChipGroup } from "@/components/ui/filter-chip-group";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { PageShell, PageBody } from "@/shell/PageShell";
import { DirectoryRow, StreamRow, levelLabelKey } from "./people/rows";
import { DismissedEntry, UnknownEntry } from "./people/triage";
import {
  directoryGroups,
  FILTER_ORDER,
  FILTER_PARAM,
  levelCounts,
  parsePeopleFilter,
  PEOPLE_VIEW_PATH,
  peoplePath,
  personPath,
  SEARCH_PARAM,
  streamRows,
  type LevelCounts,
  type PeopleFilter,
  type PeopleRow,
  type PeopleView,
  type RowLevel,
} from "./people/people-model";
import { usePeopleRoster } from "./people/use-roster";

/**
 * The People page: an activity stream and a roster, over two reads.
 *
 * Latest answers "who has something new" — one row per account with a
 * dynamic, newest first, carrying only what routing needs. Directory answers
 * "who does Rome know" — a contacts list, everyone Rome holds, by name, with no
 * preview and no count anywhere in it. Unknown and Stranger are positions on
 * the same ladder as the curated levels, so an account waiting on a decision
 * and a person the guardian placed sit in one list rather than in sections that
 * cannot say where either stands relative to the other.
 *
 * The contract is two nouns and this page is one ladder over both: `GET
 * /api/people` for the people, and the account read the view is about — `GET
 * /api/accounts` for the contacts list, `GET /api/accounts/stream` for the
 * recents surface — joined in `people-model.ts`. A person's history is a third
 * read, `GET /api/people/:id/messages`, and it belongs to the person page.
 *
 * Nothing here knows a channel. LinkedIn was the last one with a surface of its
 * own — a section below both views, reading its own mirror, for as long as a
 * LinkedIn thread resolved to no person. It resolves now, so LinkedIn arrives
 * through the same two reads as everything else and is placed, dismissed and
 * opened by the same gestures. A channel added after this page was written
 * lands here the same way, without a section.
 *
 * Both views are routes — `/people/latest` and `/people/directory` — and the
 * chip and the search term ride the query beside them. The page holds no
 * control state of its own: what is on screen is what the address says, so a
 * view is linkable, a reload returns to it, and back steps through the choices
 * that got there.
 *
 * Every number on screen is the server's. The directory pages, so a count taken
 * over the rows that happened to arrive would report no waiting senders as soon
 * as placed people filled page one — and it is why a write settles by
 * invalidating these reads rather than by editing what they returned.
 */

/** The chips whose level the people read can be narrowed by: the levels a
 *  person row actually holds. Unknown and Stranger are account states, and the
 *  account read is narrowed by those instead. */
const PLACED_FILTERS = new Set<PeopleFilter>(["inner-circle", "acquaintance", "other"]);

/**
 * `/people` is the root the two views share and renders neither: it forwards to
 * the stream, carrying whatever chip and term the link arrived with, so an
 * address written before the views had their own still lands somewhere.
 */
export function PeopleIndexRedirect() {
  const { search } = useLocation();
  return <Navigate to={{ pathname: PEOPLE_VIEW_PATH.latest, search }} replace />;
}

export default function PeoplePage({ view }: { view: PeopleView }) {
  const { t } = useTranslation("people");
  const { t: tCommon } = useTranslation("common");
  const navigate = useNavigate();

  // Every control on this page is in the address: the view in the path, the
  // chip and the term in the query. So each of the three moves by navigating,
  // and each reads back out of the URL rather than out of a second copy that
  // could disagree with it.
  const [params] = useSearchParams();
  const filter = parsePeopleFilter(params.get(FILTER_PARAM));
  const search = params.get(SEARCH_PARAM) ?? "";

  // A view or a chip is one deliberate choice and gets a history entry, so back
  // undoes it. Typing does not: a term reached by keystroke would otherwise
  // leave one entry per letter between the guardian and the page they came
  // from.
  const go = (
    next: { view?: PeopleView; filter?: PeopleFilter; search?: string },
    options?: { replace?: boolean },
  ) =>
    navigate(
      peoplePath(next.view ?? view, {
        filter: next.filter ?? filter,
        search: next.search ?? search,
      }),
      options,
    );

  // The view picks the account read: the contacts list, or the recents surface.
  //
  // The chip rides the requests in the stream, where a level is the whole view:
  // an account state is what the account read can narrow by, a bond level is
  // what the people read can. The directory view renders every group at once,
  // so it sends neither — a level on the request would leave the other headings
  // with nothing to show.
  const roster = usePeopleRoster({
    search,
    view,
    accountState: view === "directory" ? null : filter === "stranger" ? "dismissed" : "unlinked",
    personLevel: view === "directory" || !PLACED_FILTERS.has(filter) ? null : filter,
  });
  const rows = roster.rows;

  // Derived from the term the loaded rows answer, not the one in the box: the
  // box runs ahead of the request by a debounce, and filtering this page by a
  // term it was not fetched for empties it for exactly the contacts only the
  // server's search can reach.
  const settled = roster.settledSearch;
  const latest = useMemo(
    () => streamRows(rows, { search: settled, filter }),
    [rows, settled, filter],
  );
  const groups = useMemo(
    () => directoryGroups(rows, { filter, search: settled }),
    [rows, filter, settled],
  );
  // The numbers the chips and the group headings show, from the read the view
  // is on: what the stream calls Unknown is the senders waiting on a decision,
  // what the directory calls Unknown is everyone Rome has not placed.
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
        .map((row) => ({
          id: row.id,
          displayName: row.displayName,
          bondLevel: row.level,
          accounts: row.accounts,
          messageCount: row.messageCount,
          latest: row.latest,
        })),
    [rows],
  );

  // Only a person has a dossier: a dossier is a merged history, and a history
  // is what a person has. An account nobody has placed carries its evidence on
  // its own row instead.
  //
  // The address being left goes with it, so the dossier's back link returns to
  // this view on this chip and this term rather than to whichever entry happens
  // to sit behind it.
  const openRow = (row: PeopleRow) => {
    if (row.kind !== "person") return;
    navigate(personPath(row.id), {
      state: { from: peoplePath(view, { filter, search }) },
    });
  };

  const loading = roster.isPending;
  const loadError = roster.error ? roster.error.message : null;

  // Both unplaced ends of the ladder carry the gesture their position admits,
  // on the row their view has. The stream renders them dense — a placement and
  // a restore both decide on what the sender actually sent, so the evidence is
  // on the row rather than a click away — and the directory renders them as the
  // contacts line every other row is, with the gestures behind a `⋯` menu at
  // the end of it.
  const unplaced = (row: PeopleRow, variant: PeopleView) =>
    row.level === "stranger" ? (
      <DismissedEntry key={row.id} row={row} variant={variant} />
    ) : (
      <UnknownEntry key={row.id} row={row} people={linkTargets} variant={variant} />
    );

  return (
    <PageShell>
      <PageBody>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-title text-foreground">{tCommon("nav.people")}</h1>
          </div>
          {/* Both of this page's one-of-N controls are the kit's radiogroups
              rather than buttons wearing `role="radio"`: Radix supplies the
              roving focus and arrow-key movement the role promises, which a row
              of tab stops does not have. */}
          <SegmentedControl<PeopleView>
            aria-label={t("views.label")}
            value={view}
            onValueChange={(next) => go({ view: next })}
            options={[
              { value: "latest", label: t("views.latest") },
              { value: "directory", label: t("views.directory") },
            ]}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
          <Input
            type="search"
            value={search}
            onChange={(e) => go({ search: e.target.value }, { replace: true })}
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
              // Unknown is the page's one number that asks for a decision, so
              // it carries a count; the other chips are plain labels. It sits
              // at the far end for the same reason: the chips before it are
              // bonds the guardian has given, and this is what is still
              // waiting on them.
              count: option === "unknown" && counts.unknown > 0 ? counts.unknown : undefined,
              alignEnd: option === "unknown",
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
                <RefreshCw aria-hidden="true" />
                {t("errors.retry")}
              </Button>
            </AlertDescription>
          </Alert>
        ) : view === "latest" ? (
          <LatestView
            rows={latest}
            searching={settled !== ""}
            onOpen={openRow}
            renderUnplaced={(row) => unplaced(row, "latest")}
          />
        ) : (
          <DirectoryView
            groups={groups}
            counts={counts}
            onOpen={openRow}
            renderUnplaced={(row) => unplaced(row, "directory")}
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

/** The stream. Accounts nobody has placed are dense — the placement decision
 *  runs on their evidence — and every other row is lean. */
function LatestView({
  rows,
  searching,
  onOpen,
  renderUnplaced,
}: {
  rows: PeopleRow[];
  searching: boolean;
  onOpen: (row: PeopleRow) => void;
  renderUnplaced: (row: PeopleRow) => React.ReactNode;
}) {
  const { t } = useTranslation("people");
  if (rows.length === 0) {
    return (
      <div className="rounded-12 border border-dashed border-border-strong bg-surface/50 py-10 text-center">
        <p className="text-ui text-muted-foreground">
          {searching ? t("page.emptyForSearch") : t("page.emptyTitle")}
        </p>
        {!searching && (
          <p className="mt-1 text-aux text-subtle-foreground">{t("page.emptyHint")}</p>
        )}
      </div>
    );
  }

  // No heading: the stream is one ungrouped list, and the segmented control
  // above it already says which view is on screen.
  return (
    <section>
      <div className="flex flex-col">
        {rows.map((row) =>
          row.kind === "account" ? (
            renderUnplaced(row)
          ) : (
            <StreamRow key={row.id} row={row} onOpen={() => onOpen(row)} />
          ),
        )}
      </div>
    </section>
  );
}

function DirectoryView({
  groups,
  counts,
  onOpen,
  renderUnplaced,
}: {
  groups: { level: RowLevel; rows: PeopleRow[] }[];
  counts: LevelCounts;
  onOpen: (row: PeopleRow) => void;
  renderUnplaced: (row: PeopleRow) => React.ReactNode;
}) {
  const { t } = useTranslation("people");
  if (groups.length === 0) {
    return (
      <div className="rounded-12 border border-dashed border-border-strong bg-surface/50 py-10 text-center">
        <p className="text-ui text-muted-foreground">{t("page.emptyForSearch")}</p>
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
          <div className="flex flex-col">
            {group.rows.map((row) =>
              row.kind === "account" ? (
                renderUnplaced(row)
              ) : (
                <DirectoryRow key={row.id} row={row} onOpen={() => onOpen(row)} />
              ),
            )}
          </div>
        </section>
      ))}
    </>
  );
}
