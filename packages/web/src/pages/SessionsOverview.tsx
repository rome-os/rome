import { AlertCircle, AppWindow, ArrowRight, Box, Coins, Gauge, Layers3 } from "lucide-react";
import type {
  SessionMetricGroup,
  SessionMetricsDimension,
  SessionMetricsResponse,
  SessionsMetric,
} from "@rome/api-types/sessions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ModelProviderIcon } from "@/components/brand-icons/ai-tool-icons";
import { RomeLogo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState, EmptyStateIcon, EmptyStateTitle } from "@/components/ui/empty-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@rome-os/ui/spinner";
import type { RomeSessionRecord } from "@/lib/chat-types";
import { artifactLocalName } from "@/lib/artifact-name";
import { cn } from "@/lib/utils";
import { Timestamp } from "@rome-os/ui/timestamp";
import { SessionsTrendChart } from "./SessionsTrendChart";
import { costCoverage, formatCompactNumber, formatCost, formatOutcome } from "./sessions-format";

const METRIC_LABELS: Record<SessionsMetric, string> = {
  runs: "Runs",
  tokens: "Tokens",
  cost: "Estimated cost",
  errors: "Errors",
};

export const SESSION_OVERVIEW_GROUPS = [
  "app",
  "agent",
  "model",
  "project",
] as const satisfies readonly SessionMetricsDimension[];

export type SessionOverviewGroupDimension = (typeof SESSION_OVERVIEW_GROUPS)[number];

const GROUP_LABELS: Record<SessionOverviewGroupDimension, string> = {
  app: "Apps",
  agent: "Agents",
  model: "Models",
  project: "Projects",
};

function OverviewIdentity({
  group,
}: {
  group: Pick<SessionMetricGroup, "label" | "description" | "iconUrl" | "dimension">;
}) {
  const model = group.dimension.dimension === "model" ? group.dimension : null;
  const agent = group.dimension.dimension === "agent";
  const avatarShape = agent ? "rounded-full after:rounded-full" : "rounded-8 after:rounded-8";
  return (
    <div className="flex min-w-0 items-center gap-3">
      {model ? (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-8 border border-border bg-background">
          <ModelProviderIcon
            model={model.state === "known" ? model.name : null}
            provider={model.state === "known" ? model.provider : null}
            className="size-4"
            fallback="rome"
          />
        </span>
      ) : (
        <Avatar className={cn("size-8 border border-border bg-muted", avatarShape)}>
          {group.iconUrl ? (
            <AvatarImage
              src={group.iconUrl}
              alt=""
              className={agent ? "rounded-full" : "rounded-8"}
            />
          ) : null}
          <AvatarFallback className={agent ? "rounded-full" : "rounded-8"}>
            <RomeLogo className="size-4 [--background:var(--muted)]" aria-hidden />
          </AvatarFallback>
        </Avatar>
      )}
      <div className="min-w-0">
        <div className="truncate text-ui text-foreground">{group.label}</div>
        {group.description && !model ? (
          <div className="truncate text-aux text-muted-foreground">{group.description}</div>
        ) : null}
      </div>
    </div>
  );
}

function RecentSessions({
  sessions,
  error,
  loading,
  onOpen,
  onViewAll,
}: {
  sessions: RomeSessionRecord[];
  error: string | null;
  loading: boolean;
  onOpen: (session: RomeSessionRecord) => void;
  onViewAll: () => void;
}) {
  return (
    <section aria-labelledby="recent-sessions-heading" className="min-w-0">
      <div className="flex h-9 items-center justify-between gap-3">
        <h2 id="recent-sessions-heading" className="text-section">
          Recent sessions
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 px-2 text-muted-foreground"
          onClick={onViewAll}
        >
          View all
          <ArrowRight />
        </Button>
      </div>
      <div className="mt-2 divide-y divide-border-subtle border-y border-border-subtle">
        {loading && sessions.length === 0
          ? Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className="flex h-[3.25rem] items-center gap-3 py-2">
                <Skeleton className="size-8 shrink-0 rounded-8" />
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-3.5 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
            ))
          : null}
        {!loading && error ? (
          <div className="flex h-[3.25rem] items-center text-ui text-muted-foreground">
            Recent sessions unavailable
          </div>
        ) : null}
        {!loading && !error && sessions.length === 0 ? (
          <div className="flex h-[3.25rem] items-center text-ui text-muted-foreground">
            No sessions in this period
          </div>
        ) : null}
        {sessions.map((session) => (
          <button
            key={session.id}
            type="button"
            className="flex h-[3.25rem] w-full items-center gap-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            onClick={() => onOpen(session)}
            aria-label={`Open ${session.displayTitle}`}
          >
            <Avatar className="size-8 shrink-0 rounded-8 border border-border bg-muted after:rounded-8">
              {session.owner.iconUrl ? (
                <AvatarImage src={session.owner.iconUrl} alt="" className="rounded-8" />
              ) : null}
              <AvatarFallback className="rounded-8">
                <RomeLogo className="size-3.5 [--background:var(--muted)]" aria-hidden />
              </AvatarFallback>
            </Avatar>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-ui text-foreground">{session.displayTitle}</span>
              <span className="block truncate text-aux text-muted-foreground">
                {session.owner.label} · {artifactLocalName(session.agentName ?? "main")}
              </span>
            </span>
            <span className="shrink-0 text-right text-aux text-muted-foreground">
              <Timestamp value={session.activityAt ?? session.createdAt} className="block" />
              <span className="mt-1 block tabular-nums">
                {formatCompactNumber(session.stats.usage.totalTokens)} tokens
              </span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

export function SessionsOverview({
  data,
  error,
  loading,
  metric,
  trendBy,
  groupBy,
  recentSessions,
  recentSessionsError,
  recentSessionsLoading,
  onMetricChange,
  onTrendByChange,
  onGroupByChange,
  onGroupSelect,
  onRecentSessionOpen,
  onSeriesSelect,
  onViewAllSessions,
}: {
  data: SessionMetricsResponse | null;
  error: string | null;
  loading: boolean;
  metric: SessionsMetric;
  trendBy: "app" | "model";
  groupBy: SessionOverviewGroupDimension;
  recentSessions: RomeSessionRecord[];
  recentSessionsError: string | null;
  recentSessionsLoading: boolean;
  onMetricChange: (metric: SessionsMetric) => void;
  onTrendByChange: (trendBy: "app" | "model") => void;
  onGroupByChange: (groupBy: SessionOverviewGroupDimension) => void;
  onGroupSelect: (group: SessionMetricGroup) => void;
  onRecentSessionOpen: (session: RomeSessionRecord) => void;
  onSeriesSelect: (series: SessionMetricGroup) => void;
  onViewAllSessions: () => void;
}) {
  if (error && !data) {
    return (
      <Alert variant="destructive" className="mx-5 mt-5">
        <AlertCircle />
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  if (!data) {
    return (
      <div className="space-y-8 px-5 py-7">
        <div className="grid grid-cols-2 gap-6 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-16" />
          ))}
        </div>
        <Skeleton className="h-[24rem]" />
        <Skeleton className="h-72" />
      </div>
    );
  }

  const coverage = costCoverage(data.totals.usage, data.totals.runCount);
  const summary = [
    {
      label: "Runs",
      value: formatCompactNumber(data.totals.runCount),
      detail: "Agent turns in range",
      icon: Gauge,
    },
    {
      label: "Sessions",
      value: formatCompactNumber(data.totals.sessionCount),
      detail: "With activity in range",
      icon: AppWindow,
    },
    {
      label: "Tokens",
      value: formatCompactNumber(data.totals.usage.totalTokens),
      detail: `${formatCompactNumber(data.totals.usage.inputTokens)} input · ${formatCompactNumber(data.totals.usage.outputTokens)} output`,
      icon: Layers3,
    },
    {
      label: "Estimated cost",
      value: formatCost(data.totals.usage.costUsd),
      detail: coverage ?? "Across known provider rates",
      icon: Coins,
    },
  ];
  const trend = data.projections.find((projection) => projection.id === "trend");
  const groups = data.projections.find((projection) => projection.id === "breakdown")?.groups ?? [];
  const maxGroupRuns = Math.max(...groups.map((group) => group.runCount), 1);
  const columns: DataTableColumn<SessionMetricGroup>[] = [
    {
      id: "group",
      header: "Group",
      className: "min-w-52",
      cell: (group) => <OverviewIdentity group={group} />,
    },
    {
      id: "sessions",
      header: "Sessions",
      className: "text-right tabular-nums",
      headerClassName: "text-right",
      cell: (group) => formatCompactNumber(group.sessionCount),
    },
    {
      id: "runs",
      header: "Runs",
      className: "min-w-32 text-right tabular-nums",
      headerClassName: "text-right",
      cell: (group) => (
        <div className="relative overflow-hidden rounded-8 px-2 py-1">
          <span
            className="absolute inset-y-0 left-0 bg-primary/8"
            style={{ width: `${(group.runCount / maxGroupRuns) * 100}%` }}
          />
          <span className="relative">{formatCompactNumber(group.runCount)}</span>
        </div>
      ),
    },
    {
      id: "tokens",
      header: "Tokens",
      className: "text-right tabular-nums",
      headerClassName: "text-right",
      cell: (group) => formatCompactNumber(group.usage.totalTokens),
    },
    {
      id: "cost",
      header: "Estimated cost",
      className: "text-right tabular-nums",
      headerClassName: "text-right",
      cell: (group) => (
        <div>
          <div>{formatCost(group.usage.costUsd)}</div>
          {costCoverage(group.usage, group.runCount) ? (
            <div className="text-aux text-muted-foreground">
              {costCoverage(group.usage, group.runCount)}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      id: "outcome",
      header: "Outcome",
      className: "min-w-48 text-muted-foreground",
      cell: (group) => formatOutcome(group.outcomes),
    },
    {
      id: "activity",
      header: "Last activity",
      cell: (group) => <Timestamp value={group.lastActivityAt} />,
    },
  ];

  return (
    <div className="px-5 py-5">
      {error ? (
        <Alert variant="destructive" className="mb-5">
          <AlertCircle />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <section
        aria-label="Usage summary"
        className="grid grid-cols-2 gap-x-6 gap-y-4 lg:grid-cols-4 lg:gap-y-0"
      >
        {summary.map(({ label, value, detail, icon: Icon }, index) => (
          <div
            key={label}
            className={`min-w-0 ${index < summary.length - 1 ? "lg:border-r lg:border-border-subtle lg:pr-5" : ""}`}
          >
            <div className="flex items-center gap-2 text-aux text-muted-foreground">
              <Icon className="size-3.5" />
              {label}
            </div>
            <div className="mt-2 flex min-w-0 items-baseline gap-2">
              <div className="shrink-0 truncate text-title text-foreground tabular-nums">
                {value}
              </div>
              <div className="min-w-0 truncate text-aux text-muted-foreground">{detail}</div>
            </div>
          </div>
        ))}
      </section>

      <div className="mt-6 border-t border-border-subtle pt-5">
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem] xl:gap-8">
          <section className="min-w-0 xl:order-first" aria-labelledby="usage-trend-heading">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
              <h2 id="usage-trend-heading" className="text-section">
                {METRIC_LABELS[metric]} over time
              </h2>
              <div className="flex flex-wrap gap-2">
                <Select
                  value={metric}
                  onValueChange={(value) => onMetricChange(value as SessionsMetric)}
                >
                  <SelectTrigger aria-label="Trend metric" className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(METRIC_LABELS).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <ButtonGroup
                  aria-label="Trend attribution"
                  className="rounded-8 bg-muted p-1 [&>[data-slot=button]]:rounded-8! [&>[data-slot=button]]:border-0"
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    className={
                      trendBy === "model"
                        ? "bg-background shadow-1 hover:bg-background"
                        : "text-muted-foreground"
                    }
                    onClick={() => onTrendByChange("model")}
                  >
                    By model
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={
                      trendBy === "app"
                        ? "bg-background shadow-1 hover:bg-background"
                        : "text-muted-foreground"
                    }
                    onClick={() => onTrendByChange("app")}
                  >
                    By App
                  </Button>
                </ButtonGroup>
              </div>
            </div>
            <SessionsTrendChart
              buckets={trend?.buckets ?? []}
              series={trend?.groups ?? []}
              metric={metric}
              onSeriesSelect={onSeriesSelect}
            />
          </section>
          <div className="order-first xl:order-last xl:border-l xl:border-border-subtle xl:pl-8">
            <RecentSessions
              sessions={recentSessions}
              error={recentSessionsError}
              loading={recentSessionsLoading}
              onOpen={onRecentSessionOpen}
              onViewAll={onViewAllSessions}
            />
          </div>
        </div>
      </div>

      <section
        className="mt-6 border-t border-border-subtle pt-5"
        aria-labelledby="grouped-analysis-heading"
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 id="grouped-analysis-heading" className="text-section">
              Usage by {GROUP_LABELS[groupBy].toLowerCase()}
            </h2>
            <p className="mt-1 text-body text-muted-foreground">
              Select a row to inspect the matching Sessions.
            </p>
          </div>
          <Select
            value={groupBy}
            onValueChange={(value) => onGroupByChange(value as SessionOverviewGroupDimension)}
          >
            <SelectTrigger aria-label="Group by" className="w-36">
              <Box />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SESSION_OVERVIEW_GROUPS.map((value) => (
                <SelectItem key={value} value={value}>
                  {GROUP_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="hidden md:block">
          <DataTable
            columns={columns}
            data={groups}
            emptyMessage="No runs in this period"
            getRowKey={(group) => group.key}
            loading={loading && groups.length === 0}
            onRowClick={onGroupSelect}
          />
        </div>
        <div className="divide-y divide-border-subtle rounded-12 border border-border md:hidden">
          {groups.length === 0 ? (
            <EmptyState>
              {loading ? (
                <EmptyStateIcon>
                  <Spinner label="Loading" />
                </EmptyStateIcon>
              ) : null}
              <EmptyStateTitle>{loading ? "Loading" : "No runs in this period"}</EmptyStateTitle>
            </EmptyState>
          ) : (
            groups.map((group) => (
              <button
                key={group.key}
                type="button"
                className="block w-full px-4 py-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                onClick={() => onGroupSelect(group)}
              >
                <OverviewIdentity group={group} />
                <div className="mt-4 grid grid-cols-2 gap-3 text-aux">
                  <div>
                    <div className="text-muted-foreground">Sessions</div>
                    <div className="mt-1 tabular-nums">{group.sessionCount}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Runs</div>
                    <div className="mt-1 tabular-nums">{group.runCount}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Tokens</div>
                    <div className="mt-1 tabular-nums">
                      {formatCompactNumber(group.usage.totalTokens)}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Estimated cost</div>
                    <div className="mt-1 tabular-nums">{formatCost(group.usage.costUsd)}</div>
                    {costCoverage(group.usage, group.runCount) ? (
                      <div className="mt-1 text-muted-foreground">
                        {costCoverage(group.usage, group.runCount)}
                      </div>
                    ) : null}
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-between gap-4 text-aux text-muted-foreground">
                  <span className="truncate">{formatOutcome(group.outcomes)}</span>
                  <Timestamp value={group.lastActivityAt} className="shrink-0" />
                </div>
              </button>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
