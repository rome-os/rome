import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  CircleCheck,
  CircleX,
  Copy,
  ExternalLink,
  GitFork,
  RefreshCw,
  Search,
  SquareActivity,
  X,
} from "lucide-react";
import { Link, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { RomeLogo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState, EmptyStateIcon, EmptyStateTitle } from "@/components/ui/empty-state";
import { Spinner } from "@rome-os/ui/spinner";
import {
  TraceDrawer,
  traceDrawerContentInsetClass,
  type TraceDrawerTarget,
} from "@/components/agent-trace/TraceDrawer";
import { renderFlatBlocks, renderSingleBlock } from "@/components/chat/blocks";
import { buildChatView, buildRows, type AgentIdentity } from "@/components/chat/chat-view";
import { MessageList, type BlockActions } from "@/components/chat/MessageList";
import {
  getSession,
  getSessionMetrics,
  getRomeSession,
  listSessionTurns,
  listRomeSessionMessages,
  listRomeSessions,
  openTurnStream,
  postSessionTurn,
  type ListRomeSessionsOptions,
} from "@/lib/chat-api";
import { emitSessionsChanged } from "@/lib/session-events";
import { parseSSEEvents } from "@/lib/chat-sse";
import { artifactLocalName } from "@/lib/artifact-name";
import type {
  ChatMessage,
  RomeSessionRecord,
  RomeSessionsPageResult,
  StreamBlock,
} from "@/lib/chat-types";
import type { TraceSegment, TraceSnapshot } from "@rome/api-types/trace-segments";
import type {
  RomeSessionDetail,
  RomeSessionType,
  SessionModelFilter,
  SessionMetricGroup,
  SessionMetricsResponse,
  SessionOwnerFilter,
  SessionSourceFilter,
  SessionsMetric,
  SessionsRange,
  SessionsSort,
} from "@rome/api-types/sessions";
import { SessionsOverview, type SessionOverviewGroupDimension } from "./SessionsOverview";
import {
  costCoverage,
  formatCompactNumber,
  formatCost,
  formatDate,
  formatOutcome,
  formatRelativeDate,
  SESSION_TYPE_LABELS,
  sourceLabel,
} from "./sessions-format";

const PAGE_SIZE = 50;
const ALL = "__all__";
const INTERNAL_SOURCE = "__internal__";
const NO_OP = () => {};

function sessionAgentLabel(agentName: string | null | undefined): string {
  return artifactLocalName(agentName ?? "main");
}

function sessionTriggerLabel(session: RomeSessionRecord | RomeSessionDetail): string | null {
  return (
    session.triggerName ??
    (session.triggerActionName ? artifactLocalName(session.triggerActionName) : null)
  );
}

function sessionKindVariant(
  kind: string,
): "default" | "info" | "success" | "warning" | "brand" | "muted" {
  if (kind === "webchat") return "success";
  if (kind === "webchat_handoff") return "info";
  if (kind === "channel") return "brand";
  if (kind === "action") return "warning";
  if (kind === "fork") return "default";
  if (kind === "subagent") return "info";
  return "muted";
}

function useRomeSessions(options: ListRomeSessionsOptions, enabled: boolean) {
  const [data, setData] = useState<RomeSessionsPageResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    listRomeSessions(options)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load sessions");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, options, revision]);

  return { data, loading, error, refresh: () => setRevision((value) => value + 1) };
}

function useSessionMetrics(options: Parameters<typeof getSessionMetrics>[0], enabled: boolean) {
  const [data, setData] = useState<SessionMetricsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getSessionMetrics(options)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load usage");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, options, revision]);

  return { data, loading, error, refresh: () => setRevision((value) => value + 1) };
}

function useSessionsExplorerState() {
  const [range, setRange] = useState<SessionsRange>("7d");
  const [metric, setMetric] = useState<SessionsMetric>("tokens");
  const [trendBy, setTrendBy] = useState<"app" | "model">("model");
  const [groupBy, setGroupBy] = useState<SessionOverviewGroupDimension>("app");
  const [sort, setSort] = useState<SessionsSort>("activity");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [type, setType] = useState<RomeSessionType>();
  const [source, setSource] = useState<SessionSourceFilter>();
  const [owner, setOwner] = useState<{ filter: SessionOwnerFilter; label: string }>();
  const [agentName, setAgentName] = useState<string>();
  const [model, setModel] = useState<SessionModelFilter>();
  const [project, setProject] = useState<{ path: string; label: string }>();

  return {
    agentName,
    groupBy,
    metric,
    model,
    offset,
    owner,
    project,
    query,
    range,
    setAgentName,
    setGroupBy,
    setMetric,
    setModel,
    setOffset,
    setOwner,
    setProject,
    setQuery,
    setRange,
    setSort,
    setSource,
    setTrendBy,
    setType,
    sort,
    source,
    trendBy,
    type,
  };
}

type SessionsExplorerState = ReturnType<typeof useSessionsExplorerState>;

export function sessionsViewportClass(fullMode: boolean): string {
  return fullMode ? "h-dvh pt-safe" : "h-[var(--rome-mobile-content-height)] md:h-dvh";
}

function SessionsIndexPage({
  state,
  view,
}: {
  state: SessionsExplorerState;
  view: "overview" | "sessions";
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const fullMode = location.pathname.startsWith("/full/apps/sessions");
  const {
    agentName,
    groupBy,
    metric,
    model,
    offset,
    owner,
    project,
    query,
    range,
    setAgentName,
    setGroupBy,
    setMetric,
    setModel,
    setOffset,
    setOwner,
    setProject,
    setQuery,
    setRange,
    setSort,
    setSource,
    setTrendBy,
    setType,
    sort,
    source,
    trendBy,
    type,
  } = state;
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const options = useMemo<ListRomeSessionsOptions>(
    () => ({
      limit: PAGE_SIZE,
      offset,
      query: debouncedQuery,
      range,
      timeZone,
      type,
      source,
      owner: owner?.filter,
      agentName,
      model,
      projectPathPrefix: project?.path,
      sort,
    }),
    [agentName, debouncedQuery, model, offset, owner, project, range, sort, source, timeZone, type],
  );
  const metricsOptions = useMemo(
    () => ({
      range,
      timeZone,
      metric,
      trendBy,
      groupBy,
      owner: owner?.filter,
      agentName,
      model,
      projectPathPrefix: project?.path,
      type,
      source,
    }),
    [agentName, groupBy, metric, model, owner, project, range, source, timeZone, trendBy, type],
  );
  const recentOptions = useMemo<ListRomeSessionsOptions>(
    () => ({
      limit: 5,
      offset: 0,
      range,
      timeZone,
      type,
      source,
      owner: owner?.filter,
      agentName,
      model,
      projectPathPrefix: project?.path,
      sort: "activity",
    }),
    [agentName, model, owner, project, range, source, timeZone, type],
  );
  const inventory = useRomeSessions(options, view === "sessions");
  const metrics = useSessionMetrics(metricsOptions, view === "overview");
  const recentInventory = useRomeSessions(recentOptions, view === "overview");
  const { data, loading, error } = inventory;
  const sessions = data?.sessions ?? [];
  const columns = useMemo<DataTableColumn<RomeSessionRecord>[]>(
    () => [
      {
        id: "session",
        header: "Session",
        className: "w-80 max-w-80",
        headerClassName: "w-80",
        cell: (session) => (
          <div className="flex min-w-0 items-center gap-3">
            <Avatar className="size-9 shrink-0 rounded-8 border border-border bg-muted after:rounded-8">
              {session.owner.iconUrl ? (
                <AvatarImage src={session.owner.iconUrl} alt="" className="rounded-8" />
              ) : null}
              <AvatarFallback className="rounded-8">
                <RomeLogo className="size-4 [--background:var(--muted)]" aria-hidden />
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <div className="truncate text-foreground">{session.displayTitle}</div>
              <div className="truncate text-aux text-muted-foreground">
                {session.owner.label} · {sessionAgentLabel(session.agentName)}
              </div>
            </div>
          </div>
        ),
      },
      {
        id: "context",
        header: "Context",
        className: "w-48 max-w-48",
        headerClassName: "w-48",
        cell: (session) => (
          <div>
            <Badge variant={sessionKindVariant(session.type)} shape="square">
              {SESSION_TYPE_LABELS[session.type]}
            </Badge>
            <div className="mt-2 truncate text-aux text-muted-foreground">
              {session.type === "action"
                ? (sessionTriggerLabel(session) ?? "Background run")
                : (session.sourceThreadName ?? sourceLabel(session.sourceChannel))}
            </div>
          </div>
        ),
      },
      {
        id: "runs",
        header: "Runs",
        className: "w-16 text-right tabular-nums",
        headerClassName: "w-16 text-right",
        cell: (session) => formatCompactNumber(session.stats.runCount),
      },
      {
        id: "usage",
        header: "Usage",
        className: "w-36 text-right tabular-nums",
        headerClassName: "w-36 text-right",
        cell: (session) => (
          <div>
            <div className="text-foreground">
              {formatCompactNumber(session.stats.usage.totalTokens)} tokens
            </div>
            <div className="text-aux text-muted-foreground">
              {formatCost(session.stats.usage.costUsd)}
            </div>
            {costCoverage(session.stats.usage, session.stats.runCount) ? (
              <div className="text-aux text-muted-foreground">
                {costCoverage(session.stats.usage, session.stats.runCount)}
              </div>
            ) : null}
          </div>
        ),
      },
      {
        id: "outcome",
        header: "Outcome",
        className: "w-44 max-w-44",
        headerClassName: "w-44",
        cell: (session) => (
          <div className="flex items-center gap-2 text-ui">
            {session.stats.outcomes.error > 0 ? (
              <CircleX className="size-4 text-destructive" />
            ) : session.stats.outcomes.completed > 0 ? (
              <CircleCheck className="size-4 text-emerald-600" />
            ) : (
              <SquareActivity className="size-4 text-muted-foreground" />
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="truncate text-muted-foreground">
                  {formatOutcome(session.stats.outcomes)}
                </span>
              </TooltipTrigger>
              <TooltipContent>{formatOutcome(session.stats.outcomes)}</TooltipContent>
            </Tooltip>
          </div>
        ),
      },
      {
        id: "activity",
        header: "Last activity",
        className: "w-28 whitespace-nowrap",
        headerClassName: "w-28",
        cell: (session) => (
          <Tooltip>
            <TooltipTrigger asChild>
              <span>{formatRelativeDate(session.activityAt ?? session.createdAt)}</span>
            </TooltipTrigger>
            <TooltipContent>{formatDate(session.activityAt ?? session.createdAt)}</TooltipContent>
          </Tooltip>
        ),
      },
    ],
    [],
  );

  const drillInto = useCallback(
    (group: SessionMetricGroup) => {
      const dimension = group.dimension;
      if (dimension.dimension === "other") return;
      if (dimension.dimension === "app") {
        const filter: SessionOwnerFilter =
          dimension.state === "uninstalled"
            ? { kind: "uninstalled" }
            : dimension.state === "core"
              ? { kind: "core" }
              : { kind: "app", appId: dimension.appId };
        setOwner({ filter, label: dimension.label });
      } else if (dimension.dimension === "type") {
        setType(dimension.value as RomeSessionType);
      } else if (dimension.dimension === "source") {
        setSource(
          dimension.state === "internal"
            ? { kind: "internal" }
            : { kind: "channel", channel: dimension.channel },
        );
      } else if (dimension.dimension === "agent") {
        setAgentName(dimension.name);
      } else if (dimension.dimension === "model") {
        setModel(
          dimension.state === "unknown"
            ? { kind: "unknown" }
            : {
                kind: "named",
                provider: dimension.provider ?? undefined,
                name: dimension.name,
              },
        );
      } else if (dimension.dimension === "project" && dimension.path) {
        setProject({ path: dimension.path, label: dimension.label });
      }
      setOffset(0);
      navigate("all", { relative: "path" });
    },
    [navigate, setAgentName, setModel, setOffset, setOwner, setProject, setSource, setType],
  );

  const groupSelect = (group: SessionMetricGroup) => drillInto(group);
  const seriesSelect = (series: SessionMetricGroup) => drillInto(series);

  useEffect(() => {
    setOffset(0);
  }, [agentName, model, owner, project, query, range, setOffset, sort, source, type]);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(query), 250);
    return () => window.clearTimeout(timeout);
  }, [query]);

  const refreshing =
    view === "overview" ? metrics.loading || recentInventory.loading : inventory.loading;
  const activeFilters = [
    owner
      ? {
          key: "owner",
          label: `App: ${owner.label}`,
          clear: () => setOwner(undefined),
        }
      : null,
    type
      ? {
          key: "type",
          label: `Type: ${SESSION_TYPE_LABELS[type]}`,
          clear: () => setType(undefined),
        }
      : null,
    source
      ? {
          key: "source",
          label: `Source: ${sourceLabel(source.kind === "internal" ? null : source.channel)}`,
          clear: () => setSource(undefined),
        }
      : null,
    agentName
      ? {
          key: "agentName",
          label: `Agent: ${artifactLocalName(agentName)}`,
          clear: () => setAgentName(undefined),
        }
      : null,
    model
      ? {
          key: "model",
          label: `Model: ${model.kind === "unknown" ? "Unknown" : model.name}`,
          clear: () => setModel(undefined),
        }
      : null,
    project
      ? {
          key: "project",
          label: `Project: ${project.label}`,
          clear: () => setProject(undefined),
        }
      : null,
  ].filter((value): value is { key: string; label: string; clear: () => void } => value !== null);
  const openSession = useCallback(
    (session: RomeSessionRecord) => {
      navigate(
        view === "overview"
          ? encodeURIComponent(session.id)
          : `../${encodeURIComponent(session.id)}`,
        {
          relative: "path",
          state: { sessionsReturnTo: view },
        },
      );
    },
    [navigate, view],
  );

  return (
    <TooltipProvider delayDuration={150}>
      <main
        data-safe-area-bounded
        className={`flex min-h-0 flex-col overflow-hidden ${sessionsViewportClass(fullMode)}`}
      >
        <header className="shrink-0 border-b border-border bg-background px-5 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <SegmentedControl
                aria-label="Sessions view"
                value={view}
                onValueChange={(value) => {
                  if (value === view) return;
                  navigate(value === "sessions" ? "all" : "..", { relative: "path" });
                }}
                options={[
                  { value: "overview", label: "Overview" },
                  { value: "sessions", label: "Sessions" },
                ]}
              />
              {activeFilters.length > 0 ? (
                <Separator className="h-5" orientation="vertical" />
              ) : null}
              {activeFilters.map((filter) => (
                <Button key={filter.key} variant="secondary" size="sm" onClick={filter.clear}>
                  {filter.label}
                  <span aria-hidden>×</span>
                </Button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Select value={range} onValueChange={(value) => setRange(value as SessionsRange)}>
                <SelectTrigger aria-label="Time range" className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="24h">24 hours</SelectItem>
                  <SelectItem value="7d">7 days</SelectItem>
                  <SelectItem value="30d">30 days</SelectItem>
                  <SelectItem value="all">All time</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                onClick={() => {
                  if (view === "overview") {
                    metrics.refresh();
                    recentInventory.refresh();
                  } else inventory.refresh();
                }}
                disabled={refreshing}
              >
                <RefreshCw className={refreshing ? "animate-spin" : ""} />
                Refresh
              </Button>
            </div>
          </div>
        </header>

        <div data-safe-area-scroll className="min-h-0 flex-1 overflow-auto pb-safe">
          {view === "overview" ? (
            <SessionsOverview
              data={metrics.data}
              error={metrics.error}
              loading={metrics.loading}
              metric={metric}
              trendBy={trendBy}
              groupBy={groupBy}
              recentSessions={recentInventory.data?.sessions ?? []}
              recentSessionsError={recentInventory.error}
              recentSessionsLoading={recentInventory.loading}
              onMetricChange={setMetric}
              onTrendByChange={setTrendBy}
              onGroupByChange={setGroupBy}
              onGroupSelect={groupSelect}
              onRecentSessionOpen={openSession}
              onSeriesSelect={seriesSelect}
              onViewAllSessions={() => {
                setSort("activity");
                setOffset(0);
                navigate("all", { relative: "path" });
              }}
            />
          ) : (
            <div className="px-5 py-5">
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <div className="relative min-w-64 flex-1 sm:max-w-sm">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search title, App, Agent, context, or ID"
                    className="pl-8"
                  />
                </div>
                <Select
                  value={type ?? ALL}
                  onValueChange={(value) =>
                    setType(value === ALL ? undefined : (value as RomeSessionType))
                  }
                >
                  <SelectTrigger className="w-40">
                    <SelectValue placeholder="Type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>All types</SelectItem>
                    {(data?.facets.types ?? []).map((facet) =>
                      facet.value ? (
                        <SelectItem key={facet.value} value={facet.value}>
                          {SESSION_TYPE_LABELS[facet.value as keyof typeof SESSION_TYPE_LABELS] ??
                            facet.value}{" "}
                          ({facet.count})
                        </SelectItem>
                      ) : null,
                    )}
                  </SelectContent>
                </Select>
                <Select
                  value={
                    source?.kind === "internal"
                      ? INTERNAL_SOURCE
                      : source?.kind === "channel"
                        ? source.channel
                        : ALL
                  }
                  onValueChange={(value) =>
                    setSource(
                      value === ALL
                        ? undefined
                        : value === INTERNAL_SOURCE
                          ? { kind: "internal" }
                          : { kind: "channel", channel: value },
                    )
                  }
                >
                  <SelectTrigger className="w-40">
                    <SelectValue placeholder="Source" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>All sources</SelectItem>
                    {(data?.facets.sourceChannels ?? []).map((facet) => (
                      <SelectItem
                        key={facet.value ?? INTERNAL_SOURCE}
                        value={facet.value ?? INTERNAL_SOURCE}
                      >
                        {sourceLabel(facet.value)} ({facet.count})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={sort} onValueChange={(value) => setSort(value as SessionsSort)}>
                  <SelectTrigger className="w-44">
                    <SelectValue placeholder="Sort" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="activity">Last activity</SelectItem>
                    <SelectItem value="runs">Most runs</SelectItem>
                    <SelectItem value="tokens">Most tokens</SelectItem>
                    <SelectItem value="cost">Highest cost</SelectItem>
                    <SelectItem value="errors">Most errors</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {error ? (
                <div className="mb-4 rounded-12 border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui text-destructive">
                  {error}
                </div>
              ) : null}
              <div className="hidden md:block">
                <DataTable
                  columns={columns}
                  data={sessions}
                  emptyMessage="No sessions found"
                  getRowKey={(session) => session.id}
                  loading={loading && sessions.length === 0}
                  loadingMessage="Loading sessions"
                  onRowClick={openSession}
                />
              </div>
              <div className="divide-y divide-border-subtle rounded-12 border border-border md:hidden">
                {sessions.length === 0 ? (
                  <EmptyState>
                    {loading ? (
                      <EmptyStateIcon>
                        <Spinner label="Loading sessions" />
                      </EmptyStateIcon>
                    ) : null}
                    <EmptyStateTitle>
                      {loading ? "Loading sessions" : "No sessions found"}
                    </EmptyStateTitle>
                  </EmptyState>
                ) : (
                  sessions.map((session) => (
                    <button
                      key={session.id}
                      type="button"
                      className="block w-full px-4 py-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                      onClick={() => openSession(session)}
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <Avatar className="size-9 shrink-0 rounded-8 border border-border bg-muted after:rounded-8">
                          {session.owner.iconUrl ? (
                            <AvatarImage src={session.owner.iconUrl} alt="" className="rounded-8" />
                          ) : null}
                          <AvatarFallback className="rounded-8">
                            <RomeLogo className="size-4 [--background:var(--muted)]" aria-hidden />
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0 flex-1">
                          <div className="truncate">{session.displayTitle}</div>
                          <div className="truncate text-aux text-muted-foreground">
                            {session.owner.label} · {sessionAgentLabel(session.agentName)}
                          </div>
                        </div>
                        <Badge variant={sessionKindVariant(session.type)} shape="square">
                          {SESSION_TYPE_LABELS[session.type]}
                        </Badge>
                      </div>
                      <div className="mt-4 grid grid-cols-3 gap-3 text-aux">
                        <div>
                          <div className="text-muted-foreground">Runs</div>
                          <div className="mt-1 tabular-nums">{session.stats.runCount}</div>
                        </div>
                        <div>
                          <div className="text-muted-foreground">Tokens</div>
                          <div className="mt-1 tabular-nums">
                            {formatCompactNumber(session.stats.usage.totalTokens)}
                          </div>
                        </div>
                        <div>
                          <div className="text-muted-foreground">Estimated cost</div>
                          <div className="mt-1 tabular-nums">
                            {formatCost(session.stats.usage.costUsd)}
                          </div>
                          {costCoverage(session.stats.usage, session.stats.runCount) ? (
                            <div className="mt-1 text-muted-foreground">
                              {costCoverage(session.stats.usage, session.stats.runCount)}
                            </div>
                          ) : null}
                        </div>
                      </div>
                      <div className="mt-3 flex items-center justify-between gap-4 text-aux text-muted-foreground">
                        <span className="truncate">{formatOutcome(session.stats.outcomes)}</span>
                        <span className="shrink-0">
                          {formatRelativeDate(session.activityAt ?? session.createdAt)}
                        </span>
                      </div>
                    </button>
                  ))
                )}
              </div>
              <div className="mt-3 flex items-center justify-between gap-3 text-ui text-muted-foreground">
                <span>
                  {data
                    ? `Showing ${data.total === 0 ? 0 : data.offset + 1}-${data.offset + sessions.length} of ${data.total}`
                    : "Showing sessions"}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    disabled={loading || offset === 0}
                    onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    disabled={loading || !data || data.nextOffset === null}
                    onClick={() => setOffset(data?.nextOffset ?? offset)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
    </TooltipProvider>
  );
}

function ReadOnlySessionChat({
  session,
  messages,
  liveTurn,
}: {
  session: RomeSessionRecord;
  messages: ChatMessage[];
  liveTurn: { turnId: string; snapshot: TraceSnapshot; text: string } | null;
}) {
  const [traceDrawerTarget, setTraceDrawerTarget] = useState<TraceDrawerTarget | null>(null);
  const messagesBySession = useMemo(() => {
    const map = new Map<string, ChatMessage[]>();
    for (const message of messages) {
      const list = map.get(message.sessionId);
      if (list) list.push(message);
      else map.set(message.sessionId, [message]);
    }
    return map;
  }, [messages]);
  const identity = useMemo<AgentIdentity>(
    () => ({
      name: session.agentName
        ? artifactLocalName(session.agentName)
        : session.sourceChannel || "Rome",
      iconUrl: null,
    }),
    [session.agentName, session.sourceChannel],
  );
  const view = useMemo(
    () => buildChatView(messagesBySession, session.id, identity),
    [identity, messagesBySession, session.id],
  );
  const rows = useMemo(
    () =>
      buildRows(view.displayMessages, view.identityBySession, identity, {
        runningTurnId: liveTurn?.turnId ?? null,
        isStreaming: liveTurn !== null,
      }),
    [identity, liveTurn, view],
  );
  const actions = useMemo<BlockActions>(
    () => ({
      onApprovalResolved: NO_OP,
      onSubmitAppComponent: NO_OP,
      onDismissAppComponent: NO_OP,
      interactionResults: view.interactionResults,
    }),
    [view.interactionResults],
  );
  const loadStoredTrace = useCallback(
    async (messageId: string, includeSubagentUsage: boolean): Promise<TraceSnapshot | null> => {
      const params = new URLSearchParams({
        includeSubagentUsage: String(includeSubagentUsage),
      });
      const res = await fetch(
        `/api/sessions/messages/${encodeURIComponent(messageId)}/content?${params}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { trace: TraceSnapshot | null };
      return data.trace;
    },
    [],
  );

  const drawerTarget =
    traceDrawerTarget?.kind === "live" && liveTurn
      ? {
          kind: "live" as const,
          sessionId: session.id,
          turnId: liveTurn.turnId,
          summary: liveTurn.snapshot.summary,
          segments: liveTurn.snapshot.segments,
          streaming: true,
        }
      : traceDrawerTarget;

  return (
    <TooltipProvider delayDuration={150}>
      <div className="@container/chat relative flex min-h-0 flex-1 overflow-hidden">
        <div
          className={`relative flex min-h-0 min-w-0 flex-1 flex-col @5xl/chat:transition-[width] @5xl/chat:duration-200 @5xl/chat:ease-out ${traceDrawerContentInsetClass(
            traceDrawerTarget !== null,
            false,
          )}`}
        >
          <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-y-contain pb-safe">
            <MessageList
              rows={rows}
              live={{
                isStreaming: liveTurn !== null,
                runningTurnId: liveTurn?.turnId ?? null,
                snapshot: liveTurn?.snapshot ?? null,
                text: liveTurn?.text ?? "",
                identity,
              }}
              contentRef={NO_OP}
              onOpenLiveTrace={() => {
                if (!liveTurn) return;
                setTraceDrawerTarget({
                  kind: "live",
                  sessionId: session.id,
                  turnId: liveTurn.turnId,
                  summary: liveTurn.snapshot.summary,
                  segments: liveTurn.snapshot.segments,
                  streaming: true,
                });
              }}
              onOpenStoredTrace={setTraceDrawerTarget}
              actions={actions}
            />
          </div>
        </div>
        <TraceDrawer
          target={drawerTarget}
          onClose={() => setTraceDrawerTarget(null)}
          loadStoredTrace={loadStoredTrace}
          allowSubagentUsage
          readOnly
          renderInlineBlock={(block, key) =>
            renderSingleBlock(block as StreamBlock, key, {
              onApprovalResolved: NO_OP,
              compact: true,
            })
          }
          renderRunBlocks={(blocks, live) =>
            renderFlatBlocks(blocks as StreamBlock[], {
              onApprovalResolved: NO_OP,
              compact: true,
              live,
            })
          }
        />
      </div>
    </TooltipProvider>
  );
}

function SessionDetailsSheet({
  session,
  open,
  onClose,
}: {
  session: RomeSessionDetail;
  open: boolean;
  onClose: () => void;
}) {
  const location = useLocation();
  const contextRows = [
    ["Owner", session.owner.label],
    ["Agent", sessionAgentLabel(session.agentName)],
    ["Type", SESSION_TYPE_LABELS[session.type]],
    ["Source", sourceLabel(session.sourceChannel)],
    ["Trigger", sessionTriggerLabel(session)],
    ["Project", session.projectPath ?? session.projectName],
    ["Created", formatDate(session.createdAt)],
    ["Last activity", formatDate(session.activityAt ?? session.createdAt)],
  ].filter((row): row is [string, string] => Boolean(row[1]));
  const technicalRows = [
    ["Session ID", session.id],
    ["Source thread ID", session.sourceThreadId],
    ["Trigger execution ID", session.triggerExecutionId],
    ["Root execution ID", session.rootActionExecutionId],
    ["Parent execution ID", session.parentActionExecutionId],
    ["Parent Session ID", session.parentSessionId],
    ["Parent turn ID", session.parentTurnId],
  ].filter((row): row is [string, string] => Boolean(row[1]));
  const coverage = costCoverage(session.stats.usage, session.stats.runCount);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      ariaLabel="Session details"
      widthClassName="w-full max-w-md"
    >
      <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <SheetTitle className="truncate">Session details</SheetTitle>
          <SheetDescription className="mt-1 truncate text-body text-muted-foreground">
            {session.displayTitle}
          </SheetDescription>
        </div>
        <Button variant="ghost" size="icon-md" onClick={onClose} aria-label="Close details">
          <X />
        </Button>
      </div>
      <div className="flex-1 space-y-7 overflow-y-auto px-5 py-5">
        <section>
          <h3 className="text-section uppercase text-muted-foreground">Context</h3>
          <dl className="mt-3 divide-y divide-border-subtle">
            {contextRows.map(([label, value]) => (
              <div key={label} className="grid grid-cols-[8rem_1fr] gap-3 py-2 text-ui">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="min-w-0 break-words text-foreground">{value}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section>
          <h3 className="text-section uppercase text-muted-foreground">Usage</h3>
          <dl className="mt-3 grid grid-cols-2 gap-x-5 gap-y-4 text-ui">
            <div>
              <dt className="text-muted-foreground">Runs</dt>
              <dd className="mt-1 text-title tabular-nums">
                {formatCompactNumber(session.stats.runCount)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Tokens</dt>
              <dd className="mt-1 text-title tabular-nums">
                {formatCompactNumber(session.stats.usage.totalTokens)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Estimated cost</dt>
              <dd className="mt-1 tabular-nums">{formatCost(session.stats.usage.costUsd)}</dd>
              {coverage ? <p className="mt-1 text-aux text-muted-foreground">{coverage}</p> : null}
            </div>
          </dl>
          <p className="mt-4 text-body text-muted-foreground">
            {formatOutcome(session.stats.outcomes)}
          </p>
        </section>
        {session.lineage.parent || session.lineage.children.length > 0 ? (
          <section>
            <h3 className="text-section uppercase text-muted-foreground">Lineage</h3>
            <div className="mt-3 space-y-2">
              {session.lineage.parent ? (
                <Button asChild variant="outline" className="w-full justify-start">
                  <Link
                    to={`../${encodeURIComponent(session.lineage.parent.id)}`}
                    relative="path"
                    state={location.state}
                  >
                    <GitFork />
                    Parent · {session.lineage.parent.displayTitle}
                  </Link>
                </Button>
              ) : null}
              {session.lineage.children.map((child) => (
                <Button key={child.id} asChild variant="outline" className="w-full justify-start">
                  <Link
                    to={`../${encodeURIComponent(child.id)}`}
                    relative="path"
                    state={location.state}
                  >
                    <GitFork />
                    Child · {child.displayTitle}
                  </Link>
                </Button>
              ))}
            </div>
          </section>
        ) : null}
        <details className="group border-t border-border-subtle pt-4">
          <summary className="cursor-pointer text-ui text-foreground">Technical details</summary>
          <div className="mt-3 space-y-3">
            {technicalRows.map(([label, value]) => (
              <div key={label}>
                <div className="mb-1 flex items-center justify-between gap-2 text-aux text-muted-foreground">
                  <span>{label}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-md"
                    className="size-7"
                    onClick={() => void navigator.clipboard.writeText(value)}
                    aria-label={`Copy ${label}`}
                  >
                    <Copy className="size-3.5" />
                  </Button>
                </div>
                <code className="block break-all rounded-8 bg-muted px-2 py-2 text-aux text-foreground">
                  {value}
                </code>
              </div>
            ))}
          </div>
        </details>
      </div>
    </Sheet>
  );
}

function SessionDetailPage({ sessionId }: { sessionId: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const fullMode = location.pathname.startsWith("/full/apps/sessions");
  const [session, setSession] = useState<RomeSessionDetail | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [liveTurn, setLiveTurn] = useState<{
    turnId: string;
    snapshot: TraceSnapshot;
    text: string;
  } | null>(null);

  const handleBack = useCallback(() => {
    // BrowserRouter starts its own history index at zero, so an index above
    // zero means there is an in-app entry we can safely return to.
    const routerIndex = (window.history.state as { idx?: unknown } | null)?.idx;
    if (typeof routerIndex === "number" && routerIndex > 0) {
      navigate(-1);
      return;
    }
    navigate("/sessions");
  }, [navigate]);

  const reloadMessages = useCallback(async () => {
    const result = await listRomeSessionMessages(sessionId);
    if (result) setMessages(result);
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([getRomeSession(sessionId), listRomeSessionMessages(sessionId)])
      .then(([sessionResult, messageResult]) => {
        if (cancelled) return;
        if (!sessionResult || !messageResult) {
          setError("Session not found");
          setSession(null);
          setMessages([]);
          return;
        }
        setSession(sessionResult);
        setMessages(messageResult);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load session");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!session) {
      setLiveTurn(null);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    void (async () => {
      const turns = await listSessionTurns(sessionId);
      // A turn is reported `queued` until it becomes the session's current
      // turn. It is already accepted and its stream is already addressable, so
      // skipping it would leave an answer running with nothing rendering it.
      const active =
        turns?.find((turn) => turn.status === "running") ??
        turns?.find((turn) => turn.status === "queued");
      if (!active || cancelled) {
        // The turn may have completed between the initial message snapshot and
        // this active-turn lookup. Refresh once to close that race instead of
        // leaving the detail view stale until a full page reload.
        if (!cancelled) {
          await reloadMessages();
        }
        return;
      }
      const segments: TraceSegment[] = [];
      const indexById = new Map<string, number>();
      let summary: TraceSnapshot["summary"] = {
        distinctApps: [],
        totalSteps: 0,
        invocationCounts: {},
      };
      let text = "";
      const publish = () => {
        if (!cancelled) {
          setLiveTurn({
            turnId: active.turnId,
            snapshot: { segments: segments.slice(), summary },
            text,
          });
        }
      };
      publish();
      const response = await openTurnStream(active.turnId, controller.signal);
      if (!response.ok || !response.body) {
        // The turn is accepted and running; only the attach failed. Refresh so
        // the reply still lands once the turn finishes.
        if (!cancelled) {
          setLiveTurn(null);
          await reloadMessages();
        }
        return;
      }
      if (cancelled) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finished = false;
      while (!finished && !cancelled) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const boundary = buffer.lastIndexOf("\n\n");
        if (boundary < 0) continue;
        const complete = buffer.slice(0, boundary + 2);
        buffer = buffer.slice(boundary + 2);
        for (const event of parseSSEEvents(complete)) {
          if (event.event === "segment_upsert") {
            const segment = JSON.parse(event.data) as TraceSegment;
            const existing = indexById.get(segment.id);
            if (existing === undefined) {
              indexById.set(segment.id, segments.length);
              segments.push(segment);
            } else {
              segments[existing] = segment;
            }
            publish();
          } else if (event.event === "summary_update") {
            summary = JSON.parse(event.data) as TraceSnapshot["summary"];
            publish();
          } else if (event.event === "assistant_text") {
            const payload = JSON.parse(event.data) as { text?: string };
            text = payload.text ?? "";
            publish();
          } else if (event.event === "done" || event.event === "stream_error") {
            finished = true;
          }
        }
      }
      if (!cancelled) {
        await reloadMessages();
        setLiveTurn(null);
      }
    })().catch((err) => {
      if (!cancelled && (err as { name?: string }).name !== "AbortError") {
        setError(err instanceof Error ? err.message : "Failed to attach to live turn");
      }
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [reloadMessages, session?.id, session?.type, sessionId]);

  return (
    <main
      data-safe-area-bounded
      className={`flex min-h-0 flex-col overflow-hidden ${sessionsViewportClass(fullMode)}`}
    >
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <Button variant="ghost" size="icon-md" onClick={handleBack} aria-label="Back to sessions">
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-body text-foreground">
              {session?.displayTitle ?? sessionId}
            </h1>
            {session ? (
              <Badge variant={sessionKindVariant(session.type)} shape="square">
                {SESSION_TYPE_LABELS[session.type]}
              </Badge>
            ) : null}
          </div>
          <p className="truncate text-aux text-muted-foreground">
            {session
              ? `${session.owner.label} · ${sessionAgentLabel(session.agentName)} · ${sourceLabel(session.sourceChannel)}`
              : sessionId}
          </p>
        </div>
        {session ? (
          <div className="hidden items-center gap-5 px-3 text-aux text-muted-foreground xl:flex">
            <span>
              <span className="text-foreground tabular-nums">
                {formatCompactNumber(session.stats.runCount)}
              </span>{" "}
              runs
            </span>
            <span>
              <span className="text-foreground tabular-nums">
                {formatCompactNumber(session.stats.usage.totalTokens)}
              </span>{" "}
              tokens
            </span>
            <span>
              <span className="text-foreground tabular-nums">
                {formatCost(session.stats.usage.costUsd)}
              </span>
            </span>
          </div>
        ) : null}
        {session?.parentSessionId ? (
          <Button asChild variant="outline">
            <Link
              to={`../${encodeURIComponent(session.parentSessionId)}`}
              relative="path"
              state={location.state}
            >
              <GitFork />
              {session.type === "subagent" ? "Parent" : "Forked from"}
            </Link>
          </Button>
        ) : null}
        {session?.type === "webchat" ? (
          <Button asChild variant="outline">
            <Link to={`/chat/${session.id}`}>
              <ExternalLink />
              Open chat
            </Link>
          </Button>
        ) : null}
        {session ? (
          <Button variant="outline" onClick={() => setDetailsOpen(true)}>
            Details
          </Button>
        ) : null}
      </div>
      {loading ? (
        <div className="flex flex-1 items-center justify-center text-ui text-muted-foreground">
          Loading session
        </div>
      ) : error || !session ? (
        <div className="m-5 rounded-12 border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui text-destructive">
          {error ?? "Session not found"}
        </div>
      ) : (
        <>
          <ReadOnlySessionChat session={session} messages={messages} liveTurn={liveTurn} />
        </>
      )}
      {session ? (
        <SessionDetailsSheet
          session={session}
          open={detailsOpen}
          onClose={() => setDetailsOpen(false)}
        />
      ) : null}
    </main>
  );
}

export default function SessionsPage() {
  const state = useSessionsExplorerState();
  return (
    <Routes>
      <Route index element={<SessionsIndexPage state={state} view="overview" />} />
      <Route path="all" element={<SessionsIndexPage state={state} view="sessions" />} />
      <Route path=":sessionId" element={<SessionDetailRoute />} />
    </Routes>
  );
}

function SessionDetailRoute() {
  const { sessionId } = useParams<{ sessionId: string }>();
  if (!sessionId) return null;
  return <SessionDetailPage sessionId={sessionId} />;
}
