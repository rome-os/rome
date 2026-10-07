import "./styles.css";
import { useState } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { navigateToApp, type RomeAppBootstrap } from "@rome-os/app-web-sdk";
import { ArrowLeft, CircleAlert, Moon, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@rome-os/ui/alert";
import { Button } from "@rome-os/ui/button";
import {
  EmptyState,
  EmptyStateAction,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
} from "@rome-os/ui/empty-state";
import {
  Page,
  PageActions,
  PageDescription,
  PageHeader,
  PageHeading,
  PageTitle,
} from "@rome-os/ui/page";
import { SegmentedControl } from "@rome-os/ui/segmented-control";
import { Spinner } from "@rome-os/ui/spinner";
import { Timestamp } from "@rome-os/ui/timestamp";
import {
  LIVE_REFETCH_MS,
  fetchRuns,
  fetchSchedule,
  queryKeys,
  startDream,
  type RunFilter,
  type RunListItem,
} from "./lib/api";
import { runPath, useAppRoute } from "./lib/route";
import { RunDetailPane } from "./components/RunDetail";
import { RunList, RunListSkeleton } from "./components/RunList";

// Every query stays current without the guardian asking: it refetches on an
// interval while the page is visible and again when the tab regains focus. A
// failed refetch keeps the last good data, so the UI can show it with a warning.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchInterval: 30_000,
      refetchOnWindowFocus: true,
    },
  },
});

const FILTERS: Array<{ value: RunFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "dream", label: "Dreams" },
  { value: "skill_review", label: "Skill reviews" },
];

const EMPTY_FILTER_COPY: Record<
  Exclude<RunFilter, "all">,
  { title: string; description: string }
> = {
  dream: {
    title: "No dreams yet",
    description: "A dream runs every night and on demand with Dream now.",
  },
  skill_review: {
    title: "No skill reviews yet",
    description:
      "A review runs after a chat that took many tool calls, and saves any reusable method as a skill.",
  },
};

export default function App({ bootstrap: _bootstrap }: { bootstrap: RomeAppBootstrap }) {
  return (
    <QueryClientProvider client={queryClient}>
      <DreamPage />
    </QueryClientProvider>
  );
}

function liveInterval(runs: RunListItem[] | undefined): number {
  return runs?.some((run) => run.status === "running") ? LIVE_REFETCH_MS : 30_000;
}

function DreamPage() {
  const route = useAppRoute();
  const [filter, setFilter] = useState<RunFilter>("all");
  const client = useQueryClient();

  const runsQuery = useQuery({
    queryKey: queryKeys.runs(filter),
    queryFn: () => fetchRuns(filter),
    refetchInterval: (query) => liveInterval(query.state.data),
  });
  const dreamsQuery = useQuery({
    queryKey: queryKeys.runs("dream"),
    queryFn: () => fetchRuns("dream"),
    refetchInterval: (query) => liveInterval(query.state.data),
  });
  const scheduleQuery = useQuery({ queryKey: queryKeys.schedule, queryFn: fetchSchedule });

  const dreamNow = useMutation({
    mutationFn: startDream,
    onSuccess: async (runId) => {
      navigateToApp(runPath(runId));
      await client.invalidateQueries({ queryKey: ["runs"] });
    },
  });

  const runs = runsQuery.data;
  const lastDream = dreamsQuery.data?.find((run) => run.status === "completed");
  const dreaming = dreamsQuery.data?.some((run) => run.status === "running") ?? false;
  const routeRunId = route.view === "run" ? route.runId : null;
  // On a wide screen the detail pane is always open, on the newest run until
  // one is picked. On a narrow one the list and the detail take turns.
  const selectedId = routeRunId ?? runs?.[0]?.id ?? null;
  const noRunsAtAll = filter === "all" && runs?.length === 0;

  const dreamButton = (
    <Button onClick={() => dreamNow.mutate()} disabled={dreaming || dreamNow.isPending}>
      {dreaming || dreamNow.isPending ? <Spinner size="sm" /> : <Moon />}
      {dreaming ? "Dreaming…" : "Dream now"}
    </Button>
  );

  return (
    <Page className="@container min-h-full bg-[var(--app-canvas)]">
      <PageHeader align="end">
        <PageHeading>
          <PageTitle>Dream</PageTitle>
          {lastDream || scheduleQuery.data?.nextRunAt ? (
            <PageDescription className="flex flex-wrap gap-x-1.5">
              {lastDream ? (
                <span>
                  Last dream <Timestamp value={lastDream.startedAt} />
                </span>
              ) : null}
              {lastDream && scheduleQuery.data?.nextRunAt ? (
                <span aria-hidden className="text-subtle-foreground">
                  ·
                </span>
              ) : null}
              {scheduleQuery.data?.nextRunAt ? (
                <span>
                  Next{" "}
                  <Timestamp
                    value={scheduleQuery.data.nextRunAt}
                    format={{ weekday: "short", hour: "numeric", minute: "2-digit" }}
                  />
                </span>
              ) : null}
            </PageDescription>
          ) : null}
        </PageHeading>
        <PageActions>{dreamButton}</PageActions>
      </PageHeader>

      {dreamNow.error ? (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>Failed to start a dream</AlertTitle>
          <AlertDescription>{dreamNow.error.message}</AlertDescription>
        </Alert>
      ) : null}

      {runsQuery.error && runs ? (
        <Alert variant="warning">
          <TriangleAlert />
          <AlertTitle>Updates are failing</AlertTitle>
          <AlertDescription>
            Showing the last loaded runs. {runsQuery.error.message}
          </AlertDescription>
        </Alert>
      ) : null}

      {runsQuery.error && !runs ? (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>Failed to load runs</AlertTitle>
          <AlertDescription>{runsQuery.error.message}</AlertDescription>
        </Alert>
      ) : noRunsAtAll && !routeRunId ? (
        <EmptyState className="rounded-12 border border-dashed border-border">
          <EmptyStateIcon>
            <Moon />
          </EmptyStateIcon>
          <EmptyStateTitle>No dreams yet</EmptyStateTitle>
          <EmptyStateDescription>
            Each night Rome reviews the day's conversations, updates memory, and writes a journal
            entry. Skill reviews appear here after long working chats.
          </EmptyStateDescription>
          <EmptyStateAction>{dreamButton}</EmptyStateAction>
        </EmptyState>
      ) : (
        <div className="grid min-w-0 gap-6 @4xl:grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)] @4xl:items-start">
          <div
            className={
              routeRunId ? "hidden @4xl:flex @4xl:flex-col @4xl:gap-3" : "flex flex-col gap-3"
            }
          >
            <SegmentedControl
              size="sm"
              aria-label="Show"
              options={FILTERS}
              value={filter}
              onValueChange={setFilter}
              className="self-start"
            />
            {!runs ? (
              <RunListSkeleton />
            ) : runs.length === 0 ? (
              <EmptyState className="rounded-12 border border-dashed border-border">
                <EmptyStateTitle>
                  {filter === "all" ? "No runs yet" : EMPTY_FILTER_COPY[filter].title}
                </EmptyStateTitle>
                {filter !== "all" ? (
                  <EmptyStateDescription>
                    {EMPTY_FILTER_COPY[filter].description}
                  </EmptyStateDescription>
                ) : null}
              </EmptyState>
            ) : (
              <RunList
                runs={runs}
                selectedId={routeRunId}
                openId={selectedId}
                onSelect={(id) => navigateToApp(runPath(id))}
              />
            )}
          </div>

          <div className={routeRunId ? "min-w-0" : "hidden min-w-0 @4xl:block"}>
            {routeRunId ? (
              <Button
                variant="ghost"
                size="sm"
                className="mb-4 @4xl:hidden"
                onClick={() => navigateToApp("")}
              >
                <ArrowLeft data-icon="inline-start" />
                All runs
              </Button>
            ) : null}
            {selectedId ? <RunDetailPane key={selectedId} runId={selectedId} /> : null}
          </div>
        </div>
      )}
    </Page>
  );
}
