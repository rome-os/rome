import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FolderOpen, Library, MessageSquare, Search, X } from "lucide-react";
import { Spinner } from "@rome-os/ui/spinner";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import {
  Bar,
  BarChart,
  Cell,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  ProjectDashboardChat,
  ProjectDashboardChatPage,
  ProjectDashboardChatsResponse,
  ProjectDashboardResponse,
  ProjectDashboardUsageDay,
} from "@rome/api-types/projects";
import { buildProjectChatPreview } from "@/lib/project-chat-preview";
import {
  buildProjectUsageChartTotals,
  buildProjectUsageTokenBreakdown,
} from "@/lib/project-usage-totals";
import { findScrollableYAncestor } from "@/lib/scroll-container";
import { cn } from "@/lib/utils";
import { ProjectDashboardMissingError, useProjectDashboard } from "@/lib/use-project-dashboard";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SyncStatusPanel } from "@/components/sync/SyncStatusPanel";

const heroClassName = "flex shrink-0 items-start gap-3 py-1";
const heroAvatarClassName =
  "inline-flex size-9 shrink-0 items-center justify-center rounded-8 bg-surface-muted text-muted-foreground";
const heroTextClassName = "min-w-0 flex-1";
const heroTitleClassName = "m-0 truncate text-title text-foreground";
const heroDescriptionClassName = "mt-1 mb-0 max-w-[720px] text-ui text-muted-foreground";
const panelHeaderClassName = "flex shrink-0 items-end justify-between gap-3";
const sectionTitleClassName = "m-0 text-section whitespace-nowrap text-foreground";
const sectionSubtitleClassName = "mt-1 text-aux whitespace-nowrap text-subtle-foreground";
const panelClassName = "flex h-[280px] flex-col rounded-12 border border-border bg-surface p-4";
const CHAT_PAGE_SIZE = 20;

const fmtTokens = (n: number): string => {
  if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + "K";
  return String(n);
};
// Tiered so the mono stat values stay narrow: $73.86 → $1581.5 → $12345 → $123.46k → $1.23M.
const fmtCost = (n: number): string => {
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (n >= 1e5) return "$" + (n / 1e3).toFixed(2) + "k";
  if (n >= 1e4) return "$" + n.toFixed(0);
  if (n >= 1e3) return "$" + n.toFixed(1);
  return "$" + n.toFixed(2);
};

const fmtPercent = (value: number): string => `${Math.round(value * 100)}%`;

const AUXILIARY_CHART_TEXT = {
  fill: "var(--subtle-foreground)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-aux)",
  fontWeight: "var(--text-aux--font-weight)",
  letterSpacing: "var(--text-aux--letter-spacing)",
  lineHeight: "var(--text-aux--line-height)",
};

function fmtDateLabel(value: string): string {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
}

function fmtRelativeTime(value: string): string {
  const date = new Date(value);
  const diffMs = Date.now() - date.getTime();
  if (!Number.isFinite(diffMs)) return "";
  const diffMinutes = Math.max(0, Math.floor(diffMs / 60_000));
  if (diffMinutes < 1) return "Just now";
  if (diffMinutes < 60) return `${diffMinutes} min ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} hr ago`;
  if (diffHours < 48) return "Yesterday";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

interface ProjectDashboardProps {
  path: string;
  onStartChat?: (projectPath: string) => void;
}

export function ProjectDashboard({ path, onStartChat }: ProjectDashboardProps) {
  const { t } = useTranslation("files");
  const { query, missing } = useProjectDashboard(path);

  if (query.isPending) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-ui text-subtle-foreground">{t("view.loadingFile")}</p>
      </div>
    );
  }

  if (missing) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-ui text-subtle-foreground">{t("view.selectAFile")}</p>
      </div>
    );
  }

  if (query.isError && !(query.error instanceof ProjectDashboardMissingError)) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3">
        <p className="text-ui text-subtle-foreground">{t("status.networkError")}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>
          {t("status.retry")}
        </Button>
      </div>
    );
  }

  if (!query.data) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-ui text-subtle-foreground">{t("view.selectAFile")}</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DashboardBody dashboard={query.data} onStartChat={onStartChat} />
    </div>
  );
}

function DashboardBody({
  dashboard,
  onStartChat,
}: {
  dashboard: ProjectDashboardResponse;
  onStartChat?: (projectPath: string) => void;
}) {
  const location = useLocation();
  const [usageMode, setUsageMode] = useState<"tokens" | "cost">("tokens");
  const [query, setQuery] = useState("");
  const [visibleChatLimit, setVisibleChatLimit] = useState(CHAT_PAGE_SIZE);
  const [chats, setChats] = useState<ProjectDashboardChat[]>(dashboard.chats);
  const [chatPage, setChatPage] = useState<ProjectDashboardChatPage>(dashboard.chatPage);
  const [loadingMoreChats, setLoadingMoreChats] = useState(false);
  const [chatLoadError, setChatLoadError] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const chatSentinelRef = useRef<HTMLDivElement | null>(null);
  const dashboardPageKey = `${dashboard.logicalPath}:${dashboard.chatPage.nextCursor ?? ""}:${dashboard.chatPage.total}:${dashboard.chats.map((chat) => chat.id).join(",")}`;
  const currentProjectRef = useRef(dashboard.logicalPath);
  const currentDashboardPageKeyRef = useRef(dashboardPageKey);
  const loadMoreAbortRef = useRef<AbortController | null>(null);
  const loadMoreChatsRef = useRef<(() => Promise<void>) | null>(null);
  const isAllProjects = dashboard.logicalPath === "projects";
  const chatSearch =
    new URLSearchParams(location.search).get("hideSidebar") === "1" ? "?hideSidebar=1" : "";
  currentProjectRef.current = dashboard.logicalPath;
  currentDashboardPageKeyRef.current = dashboardPageKey;
  const stats = dashboard.stats;

  useEffect(() => {
    setChats(dashboard.chats);
    setChatPage(dashboard.chatPage);
    setVisibleChatLimit(CHAT_PAGE_SIZE);
    setChatLoadError(false);
    setLoadingMoreChats(false);
  }, [dashboard]);

  useEffect(() => {
    currentProjectRef.current = dashboard.logicalPath;
    loadMoreAbortRef.current?.abort();
    loadMoreAbortRef.current = null;

    return () => {
      loadMoreAbortRef.current?.abort();
      loadMoreAbortRef.current = null;
    };
  }, [dashboard.logicalPath]);

  const loadMoreChats = useCallback(async () => {
    if (loadingMoreChats || !chatPage.hasMore) return;

    const projectPath = dashboard.logicalPath;
    const dashboardPageKeyAtRequestStart = dashboardPageKey;
    const controller = new AbortController();
    loadMoreAbortRef.current?.abort();
    loadMoreAbortRef.current = controller;
    const isCurrentRequest = () =>
      loadMoreAbortRef.current === controller &&
      currentProjectRef.current === projectPath &&
      currentDashboardPageKeyRef.current === dashboardPageKeyAtRequestStart &&
      !controller.signal.aborted;

    setLoadingMoreChats(true);
    setChatLoadError(false);
    try {
      const params = new URLSearchParams({
        limit: String(CHAT_PAGE_SIZE),
        path: projectPath,
      });
      if (chatPage.nextCursor) {
        params.set("cursor", chatPage.nextCursor);
      }
      const response = await fetch(`/api/projects/dashboard/chats?${params.toString()}`, {
        credentials: "include",
        signal: controller.signal,
      });

      if (!isCurrentRequest()) return;

      if (!response.ok) {
        setChatLoadError(true);
        return;
      }

      const body = (await response.json()) as ProjectDashboardChatsResponse;
      if (!isCurrentRequest()) return;

      setChats((current) => {
        const seen = new Set(current.map((chat) => chat.id));
        return [...current, ...body.chats.filter((chat) => !seen.has(chat.id))];
      });
      setChatPage(body.page);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (!isCurrentRequest()) return;
      setChatLoadError(true);
    } finally {
      if (isCurrentRequest()) {
        loadMoreAbortRef.current = null;
        setLoadingMoreChats(false);
      }
    }
  }, [chatPage, dashboard.logicalPath, dashboardPageKey, loadingMoreChats]);

  useLayoutEffect(() => {
    loadMoreChatsRef.current = loadMoreChats;
  }, [loadMoreChats]);

  const filteredChats = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return chats;
    return chats.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.snippet.toLowerCase().includes(q) ||
        c.searchText.toLowerCase().includes(q),
    );
  }, [chats, query]);
  const visibleChats = filteredChats.slice(0, visibleChatLimit);
  const hasMoreCachedChats = filteredChats.length > visibleChatLimit;
  const hasMoreChats = chatPage.hasMore || hasMoreCachedChats;
  const fillingChatBatch = chatPage.hasMore && filteredChats.length < visibleChatLimit;

  // A search batch may span several API pages. Fill it even if the first matches hide the sentinel.
  useEffect(() => {
    if (fillingChatBatch && !chatLoadError && !loadingMoreChats) {
      void loadMoreChatsRef.current?.();
    }
  }, [fillingChatBatch, chatLoadError, loadingMoreChats]);

  // Filtering can leave the sentinel visible after loading. Reobserve when the batch is ready.
  useEffect(() => {
    const sentinel = chatSentinelRef.current;
    if (
      !sentinel ||
      !hasMoreChats ||
      (chatLoadError && !hasMoreCachedChats) ||
      loadingMoreChats ||
      fillingChatBatch
    ) {
      return;
    }

    const root = findScrollableYAncestor(sentinel, {
      boundary: bodyRef.current,
      fallback: bodyRef.current,
    });
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleChatLimit(visibleChatLimit + CHAT_PAGE_SIZE);
        }
      },
      { root, rootMargin: "160px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [
    chatLoadError,
    hasMoreChats,
    hasMoreCachedChats,
    loadingMoreChats,
    fillingChatBatch,
    visibleChatLimit,
  ]);

  return (
    <section className="@container/project-dashboard flex h-full min-h-0 flex-col bg-surface font-sans text-ui text-foreground antialiased [text-rendering:optimizeLegibility]">
      <div
        ref={bodyRef}
        className="flex min-h-0 flex-1 flex-col gap-5 overflow-hidden px-8 pt-5 pb-6 @max-[640px]/project-dashboard:overflow-y-auto @max-[640px]/project-dashboard:px-6 @max-[640px]/project-dashboard:py-5 @max-[480px]/project-dashboard:p-5"
      >
        {isAllProjects ? (
          <header className={heroClassName}>
            <div className={heroAvatarClassName}>
              <Library size={18} strokeWidth={1.6} />
            </div>
            <div className={heroTextClassName}>
              <h1 className={heroTitleClassName}>All projects</h1>
              <p className={heroDescriptionClassName}>
                {dashboard.availableProjectPaths.length} project
                {dashboard.availableProjectPaths.length === 1 ? "" : "s"}
                {" · "}
                {stats.chatCount} chat{stats.chatCount === 1 ? "" : "s"}
                {" · "}
                {fmtCost(stats.monthCostUsd)} this month
              </p>
            </div>
          </header>
        ) : (
          <header className={heroClassName}>
            <div className={heroAvatarClassName}>
              <FolderOpen size={18} strokeWidth={1.6} />
            </div>
            <div className={heroTextClassName}>
              <h1 className={heroTitleClassName}>{dashboard.name}</h1>
            </div>
            <div className="inline-flex shrink-0 items-center gap-2 pt-1">
              <button
                type="button"
                className="inline-flex h-[var(--control-h-md)] items-center gap-[var(--control-gap-sm)] rounded-8 border border-border bg-surface px-3 text-ui whitespace-nowrap text-foreground transition-[background,border-color] duration-150 ease-in-out motion-reduce:transition-none hover:border-border-strong hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onStartChat?.(dashboard.relativePath)}
              >
                <MessageSquare size={14} strokeWidth={1.6} />
                <span>Open in chat</span>
              </button>
            </div>
          </header>
        )}

        {!isAllProjects ? <SyncStatusPanel path={dashboard.relativePath} className="mb-4" /> : null}

        <div className="grid shrink-0 grid-cols-[minmax(280px,1fr)_minmax(320px,1.4fr)] gap-4 @max-[640px]/project-dashboard:grid-cols-1">
          <section className={cn(panelClassName, "gap-3 @max-[640px]/project-dashboard:h-auto")}>
            <header className={panelHeaderClassName}>
              <h2 className={sectionTitleClassName}>Summary</h2>
            </header>
            <div className="grid flex-1 grid-cols-2 gap-2">
              <StatCell
                label="Chats"
                value={stats.chatCount}
                hint={isAllProjects ? "across all projects" : "in this project"}
              />
              <StatCell
                label="Tokens"
                value={fmtTokens(stats.totalTokens)}
                hint={`${fmtTokens(stats.monthTokens)} this month`}
              />
              <StatCell
                label="Cache hit rate"
                value={fmtPercent(stats.cacheHitRate)}
                hint="input cached"
              />
              <StatCell
                label="Spend"
                value={fmtCost(stats.totalCostUsd)}
                hint={`${fmtCost(stats.monthCostUsd)} this month`}
                progress={
                  stats.monthBudgetUsd ? stats.monthCostUsd / stats.monthBudgetUsd : undefined
                }
              />
            </div>
          </section>

          <section className={cn(panelClassName, "gap-2 @max-[640px]/project-dashboard:h-[260px]")}>
            <header className={panelHeaderClassName}>
              <div>
                <h2 className={sectionTitleClassName}>Usage</h2>
                <div className={sectionSubtitleClassName}>Last 14 days</div>
              </div>
              <SegmentedControl
                size="sm"
                aria-label="Usage metric"
                value={usageMode}
                onValueChange={(next: string) => setUsageMode(next as "tokens" | "cost")}
                className="shrink-0"
                options={[
                  { value: "tokens", label: "Tokens" },
                  { value: "cost", label: "Cost" },
                ]}
              />
            </header>
            <UsageChart mode={usageMode} usage={dashboard.usage} />
          </section>
        </div>

        <section className="flex min-h-0 flex-1 flex-col">
          <header className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className={sectionTitleClassName}>Recent chats</h2>
              <div className={sectionSubtitleClassName}>
                {visibleChats.length} of {chatPage.total} {chatPage.total === 1 ? "chat" : "chats"}
              </div>
            </div>
            <div className="flex h-[var(--control-h-md)] min-w-56 max-w-80 items-center gap-[var(--control-gap-sm)] rounded-8 border border-border bg-surface px-[var(--field-px-sm)] text-muted-foreground transition-[border-color,box-shadow] duration-150 ease-in-out motion-reduce:transition-none @max-[480px]/project-dashboard:min-w-40 focus-within:border-border-strong focus-within:ring-1 focus-within:ring-ring">
              <Search size={14} strokeWidth={1.6} />
              <input
                type="text"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setVisibleChatLimit(CHAT_PAGE_SIZE);
                }}
                placeholder="Search chats…"
                className="min-w-0 flex-1 border-0 bg-transparent font-[inherit] text-ui text-foreground outline-none placeholder:text-muted-foreground"
              />
              {query && (
                <button
                  type="button"
                  className="inline-flex size-5 items-center justify-center rounded-full border-0 bg-surface-muted p-0 text-muted-foreground transition-colors duration-150 ease-in-out motion-reduce:transition-none hover:bg-surface-hover hover:text-foreground"
                  onClick={() => {
                    setQuery("");
                    setVisibleChatLimit(CHAT_PAGE_SIZE);
                  }}
                  aria-label="Clear search"
                >
                  <X size={12} strokeWidth={1.8} />
                </button>
              )}
            </div>
          </header>

          <div className="flex min-h-0 flex-1 flex-col overflow-auto">
            {chats.length === 0 && !query && (
              <div className="mt-2 rounded-8 border border-dashed border-border px-4 py-6 text-center text-aux text-subtle-foreground">
                <div className="mb-1 text-muted-foreground">No chats yet</div>
                <div>
                  {isAllProjects
                    ? "Start a chat from any project to see it here."
                    : "Start a chat from this project to see it here."}
                </div>
              </div>
            )}
            {chats.length > 0 && filteredChats.length === 0 && query && !chatPage.hasMore && (
              <div className="mt-2 rounded-8 border border-dashed border-border px-4 py-6 text-center text-aux text-subtle-foreground">
                No chats match &ldquo;{query}&rdquo;.
              </div>
            )}
            {visibleChats.map((c) => (
              <ChatRow key={c.id} chat={c} q={query} search={chatSearch} />
            ))}
            {hasMoreChats && (
              <div
                ref={chatSentinelRef}
                className="flex min-h-11 items-center justify-center gap-2 border-t border-border text-aux text-subtle-foreground"
              >
                {loadingMoreChats ? (
                  <>
                    <Spinner size="sm" label="Loading more chats" />
                    <span aria-hidden>Loading more chats</span>
                  </>
                ) : chatLoadError && !hasMoreCachedChats ? (
                  <button
                    type="button"
                    className="border-0 bg-transparent font-[inherit] text-brand hover:underline"
                    onClick={loadMoreChats}
                  >
                    Retry loading chats
                  </button>
                ) : (
                  <span>Scroll for more chats</span>
                )}
              </div>
            )}
          </div>
        </section>
      </div>
    </section>
  );
}

function StatCell({
  label,
  value,
  hint,
  progress,
}: {
  label: string;
  value: string | number;
  hint?: string;
  progress?: number;
}) {
  return (
    <div className="flex flex-col justify-center gap-1 rounded-8 bg-surface-muted p-3">
      <div className="text-aux text-muted-foreground">{label}</div>
      <div className="font-mono text-title text-foreground">{value}</div>
      {hint && <div className="truncate text-aux text-subtle-foreground">{hint}</div>}
      {progress != null && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-hover">
          <div
            className="h-full w-full origin-left transition-transform duration-200 ease-in-out motion-reduce:transition-none will-change-transform"
            style={{
              transform: `scaleX(${Math.min(1, progress)})`,
              background: progress > 0.8 ? "var(--warning)" : "var(--brand)",
            }}
          />
        </div>
      )}
    </div>
  );
}

function UsageChart({
  mode,
  usage,
}: {
  mode: "tokens" | "cost";
  usage: ProjectDashboardUsageDay[];
}) {
  const isTokens = mode === "tokens";
  const patternId = useId().replaceAll(":", "");
  const totals = useMemo(() => buildProjectUsageChartTotals(usage), [usage]);
  const chartData = useMemo(
    () =>
      usage.map((day, index) => {
        const tokens = buildProjectUsageTokenBreakdown(day);
        return {
          cached: tokens.cached,
          cost: day.costUsd,
          date: day.date,
          input: tokens.input,
          isToday: index === usage.length - 1,
          output: tokens.output,
          total: tokens.total,
        };
      }),
    [usage],
  );
  const maximum = Math.max(1, ...chartData.map((datum) => (isTokens ? datum.total : datum.cost)));
  const firstDate = chartData[0]?.date;
  const lastDate = chartData.at(-1)?.date;
  const xTicks = firstDate
    ? lastDate && firstDate !== lastDate
      ? [firstDate, lastDate]
      : [firstDate]
    : [];

  const fmt = (v: number) => (isTokens ? fmtTokens(v) : fmtCost(v));

  const seriesColors = {
    output: "var(--brand)",
    input: "color-mix(in oklch, var(--brand) 45%, transparent)",
    cached: "color-mix(in oklch, var(--brand) 18%, transparent)",
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {isTokens ? (
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex items-baseline gap-1 text-aux whitespace-nowrap text-muted-foreground">
            <span className="text-muted-foreground">Total</span>
            <span className="font-mono text-aux text-foreground">{fmtTokens(totals.total)}</span>
          </span>
          <span className="inline-flex items-baseline gap-1 text-aux whitespace-nowrap text-muted-foreground">
            <span
              className="size-2 shrink-0 self-center"
              style={{ background: seriesColors.output }}
            />
            <span className="text-muted-foreground">Output</span>
            <span className="font-mono text-foreground">{fmtTokens(totals.output)}</span>
          </span>
          <span className="inline-flex items-baseline gap-1 text-aux whitespace-nowrap text-muted-foreground">
            <span
              className="size-2 shrink-0 self-center"
              style={{ background: seriesColors.input }}
            />
            <span className="text-muted-foreground">Input</span>
            <span className="font-mono text-foreground">{fmtTokens(totals.input)}</span>
          </span>
          <span className="inline-flex items-baseline gap-1 text-aux whitespace-nowrap text-muted-foreground">
            <span
              className="size-2 shrink-0 self-center"
              style={{ background: seriesColors.cached }}
            />
            <span className="text-muted-foreground">Cached</span>
            <span className="font-mono text-foreground">{fmtTokens(totals.cached)}</span>
          </span>
        </div>
      ) : (
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex items-baseline gap-1 text-aux whitespace-nowrap text-muted-foreground">
            <span className="text-muted-foreground">Total spend</span>
            <span className="font-mono text-aux text-foreground">{fmtCost(totals.cost)}</span>
          </span>
        </div>
      )}

      <div
        className="min-h-[120px] min-w-0 flex-1"
        role="img"
        aria-label={`${mode} usage over the last 14 days`}
      >
        <ResponsiveContainer
          width="100%"
          height="100%"
          minWidth={0}
          initialDimension={{ width: 560, height: 150 }}
        >
          <BarChart
            data={chartData}
            margin={{ top: 6, right: 4, bottom: 0, left: 0 }}
            barCategoryGap={4}
            barGap={0}
            accessibilityLayer
          >
            <defs>
              {Object.entries(seriesColors).map(([name, color]) => (
                <pattern
                  key={name}
                  id={`${patternId}-${name}`}
                  width="6"
                  height="6"
                  patternUnits="userSpaceOnUse"
                  patternTransform="rotate(45)"
                >
                  <rect width="6" height="6" fill={color} />
                  <rect
                    width="2"
                    height="6"
                    fill="color-mix(in oklch, var(--background) 65%, transparent)"
                  />
                </pattern>
              ))}
            </defs>
            <XAxis
              dataKey="date"
              ticks={xTicks}
              axisLine={false}
              tickLine={false}
              tickMargin={8}
              interval={0}
              tick={AUXILIARY_CHART_TEXT}
              tickFormatter={(value: string) =>
                value === chartData.at(-1)?.date ? "Today" : fmtDateLabel(value)
              }
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              tickMargin={8}
              ticks={[0, maximum / 2, maximum]}
              width={44}
              allowDecimals={!isTokens}
              allowDataOverflow
              domain={[0, maximum]}
              tick={AUXILIARY_CHART_TEXT}
              tickFormatter={fmt}
            />
            <ChartTooltip
              isAnimationActive={false}
              cursor={{ fill: "var(--surface-hover)", radius: 4 }}
              wrapperStyle={{ outline: "none", zIndex: 10 }}
              content={({ active, payload }) => {
                const datum = payload?.[0]?.payload as (typeof chartData)[number] | undefined;
                if (!active || !datum) return null;
                return (
                  <div
                    className="pointer-events-none rounded-8 border border-border bg-popover px-2 py-1 text-aux whitespace-nowrap text-popover-foreground shadow-4"
                    role="status"
                  >
                    <div className="mb-1 text-aux text-muted-foreground">
                      {fmtDateLabel(datum.date)}
                    </div>
                    {isTokens ? (
                      <>
                        <TooltipRow
                          color={seriesColors.output}
                          label="Output"
                          value={fmtTokens(datum.output)}
                        />
                        <TooltipRow
                          color={seriesColors.input}
                          label="Input"
                          value={fmtTokens(datum.input)}
                        />
                        <TooltipRow
                          color={seriesColors.cached}
                          label="Cached"
                          value={fmtTokens(datum.cached)}
                        />
                        <div className="mt-2 flex items-center justify-between gap-3 border-t border-border pt-2 text-aux">
                          <span className="text-muted-foreground">Total</span>
                          <span className="font-mono text-popover-foreground">
                            {fmtTokens(datum.total)}
                          </span>
                        </div>
                      </>
                    ) : (
                      <div className="font-mono text-popover-foreground">{fmtCost(datum.cost)}</div>
                    )}
                  </div>
                );
              }}
            />
            {isTokens ? (
              <>
                <Bar
                  dataKey="output"
                  name="Output"
                  stackId="tokens"
                  fill={seriesColors.output}
                  radius={[0, 0, 2, 2]}
                  isAnimationActive={false}
                >
                  {chartData.map((datum) => (
                    <Cell
                      key={datum.date}
                      fill={datum.isToday ? `url(#${patternId}-output)` : seriesColors.output}
                    />
                  ))}
                </Bar>
                <Bar
                  dataKey="input"
                  name="Input"
                  stackId="tokens"
                  fill={seriesColors.input}
                  isAnimationActive={false}
                >
                  {chartData.map((datum) => (
                    <Cell
                      key={datum.date}
                      fill={datum.isToday ? `url(#${patternId}-input)` : seriesColors.input}
                    />
                  ))}
                </Bar>
                <Bar
                  dataKey="cached"
                  name="Cached"
                  stackId="tokens"
                  fill={seriesColors.cached}
                  radius={[3, 3, 0, 0]}
                  isAnimationActive={false}
                >
                  {chartData.map((datum) => (
                    <Cell
                      key={datum.date}
                      fill={datum.isToday ? `url(#${patternId}-cached)` : seriesColors.cached}
                    />
                  ))}
                </Bar>
              </>
            ) : (
              <Bar
                dataKey="cost"
                name="Cost"
                fill={seriesColors.output}
                radius={[3, 3, 2, 2]}
                isAnimationActive={false}
              >
                {chartData.map((datum) => (
                  <Cell
                    key={datum.date}
                    fill={datum.isToday ? `url(#${patternId}-output)` : seriesColors.output}
                  />
                ))}
              </Bar>
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function TooltipRow({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div className="mt-1 grid grid-cols-[8px_1fr_auto] items-center gap-2 text-aux">
      <span className="size-2" style={{ background: color }} />
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-popover-foreground">{value}</span>
    </div>
  );
}

function ChatRow({ chat, q, search }: { chat: ProjectDashboardChat; q: string; search: string }) {
  const preview = buildProjectChatPreview({
    query: q,
    searchText: chat.searchText,
    snippet: chat.snippet,
  });

  const highlight = (text: string) => {
    if (!q) return text;
    const idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return text;
    return (
      <>
        {text.slice(0, idx)}
        <mark className="rounded-4 bg-[color-mix(in_oklch,var(--brand)_18%,transparent)] px-1 text-brand">
          {text.slice(idx, idx + q.length)}
        </mark>
        {text.slice(idx + q.length)}
      </>
    );
  };

  return (
    <Link
      to={{ pathname: `/chat/${chat.id}`, search }}
      className="flex flex-col gap-1 border-t border-border px-2 py-3 text-inherit no-underline transition-colors duration-150 ease-in-out motion-reduce:transition-none hover:bg-surface-muted"
    >
      <div className="flex items-baseline gap-3">
        <div className="min-w-0 flex-1 truncate text-ui text-foreground">
          {highlight(chat.title)}
        </div>
        <div className="shrink-0 text-aux whitespace-nowrap text-subtle-foreground">
          {fmtRelativeTime(chat.updatedAt)}
        </div>
      </div>
      <div className="line-clamp-1 text-aux text-muted-foreground">
        {preview ? highlight(preview) : "No messages yet."}
      </div>
    </Link>
  );
}

export default ProjectDashboard;
