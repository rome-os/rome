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
  ProjectDashboardProviderUsage,
  ProjectDashboardResponse,
  ProjectDashboardUsageDay,
} from "@rome/api-types/projects";
import { buildProjectChatPreview } from "@/lib/project-chat-preview";
import {
  buildProjectProviderUsageRows,
  buildProjectUsageChartTotals,
  buildProjectUsageTokenBreakdown,
  type ProjectProviderUsageRow,
  type ProjectUsageProviderKey,
} from "@/lib/project-usage-totals";
import { findScrollableYAncestor } from "@/lib/scroll-container";
import { cn } from "@/lib/utils";
import { ProjectDashboardMissingError, useProjectDashboard } from "@/lib/use-project-dashboard";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SyncStatusPanel } from "@/components/sync/SyncStatusPanel";
import { CodexIcon, ModelProviderIcon } from "@/components/brand-icons/ai-tool-icons";

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
  if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, "") + "B";
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
// A share that rounds to zero still exists; say so rather than print 0%.
const fmtShare = (value: number): string =>
  value > 0 && value < 0.005 ? "<1%" : fmtPercent(value);

// Axis ticks get three significant digits so they fit the axis gutter unclipped.
const axisNumberFormat = new Intl.NumberFormat("en", {
  maximumSignificantDigits: 3,
  notation: "compact",
});

type UsageMetric = "tokens" | "cost";
type UsageBreakdown = "type" | "provider";
type ProviderUsagePeriod = "recent" | "month" | "total";

// Claude takes the theme's strong color and Codex the ink, so the pair stays
// distinct in every theme and mode without reaching past the semantic tokens.
const PROVIDER_SERIES: Record<ProjectUsageProviderKey, { color: string; label: string }> = {
  claude: { color: "var(--primary)", label: "Claude" },
  codex: { color: "color-mix(in oklch, var(--foreground) 72%, transparent)", label: "Codex" },
  other: { color: "color-mix(in oklch, var(--foreground) 24%, transparent)", label: "Other" },
};

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
  const [usageMode, setUsageMode] = useState<UsageMetric>("tokens");
  const [usageBreakdown, setUsageBreakdown] = useState<UsageBreakdown>("type");
  const [query, setQuery] = useState("");
  const [visibleChatLimit, setVisibleChatLimit] = useState(CHAT_PAGE_SIZE);
  const [chats, setChats] = useState<ProjectDashboardChat[]>(dashboard.chats);
  const [chatPage, setChatPage] = useState<ProjectDashboardChatPage>(dashboard.chatPage);
  const [loadingMoreChats, setLoadingMoreChats] = useState(false);
  const [chatLoadError, setChatLoadError] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const chatListRef = useRef<HTMLDivElement | null>(null);
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

  const handleQueryChange = (nextQuery: string) => {
    // Reset before shrinking the list so scroll clamping cannot expose the sentinel.
    if (chatListRef.current) chatListRef.current.scrollTop = 0;
    setQuery(nextQuery);
    setVisibleChatLimit(CHAT_PAGE_SIZE);
  };

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
        className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-8 pt-5 pb-6 @max-[640px]/project-dashboard:px-6 @max-[640px]/project-dashboard:py-5 @max-[480px]/project-dashboard:p-5"
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
            <header className={cn(panelHeaderClassName, "flex-wrap")}>
              <div>
                <h2 className={sectionTitleClassName}>Usage</h2>
                <div className={sectionSubtitleClassName}>Last 14 days</div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <SegmentedControl
                  size="sm"
                  aria-label="Usage breakdown"
                  value={usageBreakdown}
                  onValueChange={(next: string) => setUsageBreakdown(next as UsageBreakdown)}
                  options={[
                    { value: "type", label: "By type" },
                    { value: "provider", label: "By provider" },
                  ]}
                />
                <SegmentedControl
                  size="sm"
                  aria-label="Usage metric"
                  value={usageMode}
                  onValueChange={(next: string) => setUsageMode(next as UsageMetric)}
                  options={[
                    { value: "tokens", label: "Tokens" },
                    { value: "cost", label: "Cost" },
                  ]}
                />
              </div>
            </header>
            <UsageChart breakdown={usageBreakdown} mode={usageMode} usage={dashboard.usage} />
          </section>
        </div>

        <ProviderUsagePanel dashboard={dashboard} />

        {/* The panels above can outgrow a short viewport; the body scrolls instead of collapsing the list. */}
        <section className="flex min-h-[320px] flex-1 flex-col">
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
                onChange={(e) => handleQueryChange(e.target.value)}
                placeholder="Search chats…"
                className="min-w-0 flex-1 border-0 bg-transparent font-[inherit] text-ui text-foreground outline-none placeholder:text-muted-foreground"
              />
              {query && (
                <button
                  type="button"
                  className="inline-flex size-5 items-center justify-center rounded-full border-0 bg-surface-muted p-0 text-muted-foreground transition-colors duration-150 ease-in-out motion-reduce:transition-none hover:bg-surface-hover hover:text-foreground"
                  onClick={() => handleQueryChange("")}
                  aria-label="Clear search"
                >
                  <X size={12} strokeWidth={1.8} />
                </button>
              )}
            </div>
          </header>

          <div ref={chatListRef} className="flex min-h-0 flex-1 flex-col overflow-auto">
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

const PROVIDER_USAGE_PERIODS: Record<ProviderUsagePeriod, { empty: string; label: string }> = {
  recent: { empty: "No usage in the last 14 days.", label: "14 days" },
  month: { empty: "No usage this month.", label: "This month" },
  total: { empty: "No usage recorded yet.", label: "All time" },
};

const providerCellClassName = "h-11 border-t border-border px-2 align-middle";
const providerNumericCellClassName = cn(
  providerCellClassName,
  "text-right font-mono whitespace-nowrap text-foreground",
);
const providerHeaderCellClassName =
  "h-8 px-2 text-left align-middle text-aux font-normal whitespace-nowrap text-muted-foreground";
// Narrow dashboards keep the share and the totals; the token split drops first.
const providerDetailClassName = "@max-[640px]/project-dashboard:hidden";
// Phone dashboards keep only the total the share is computed from, so the share
// and the figure beside it always measure the same thing.
const providerOffBasisClassName = "@max-[480px]/project-dashboard:hidden";

type ProviderUsageFigureSet = Omit<ProjectProviderUsageRow, "key">;

const PROVIDER_TABLE_COLUMNS: Array<{
  basis?: UsageMetric;
  detail: boolean;
  format: (figures: ProviderUsageFigureSet) => string;
  key: string;
  label: string;
}> = [
  { detail: true, format: (figures) => fmtTokens(figures.input), key: "input", label: "Input" },
  { detail: true, format: (figures) => fmtTokens(figures.output), key: "output", label: "Output" },
  { detail: true, format: (figures) => fmtTokens(figures.cached), key: "cached", label: "Cached" },
  {
    basis: "tokens",
    detail: false,
    format: (figures) => fmtTokens(figures.total),
    key: "total",
    label: "Tokens",
  },
  {
    basis: "cost",
    detail: false,
    format: (figures) => fmtCost(figures.cost),
    key: "cost",
    label: "Spend",
  },
];

function ProviderUsagePanel({ dashboard }: { dashboard: ProjectDashboardResponse }) {
  const [period, setPeriod] = useState<ProviderUsagePeriod>("month");
  const rows = useMemo(() => {
    const source: ProjectDashboardProviderUsage[] =
      period === "recent"
        ? dashboard.usage.flatMap((day) => day.providers)
        : dashboard.providerUsage[period];
    return buildProjectProviderUsageRows(source);
  }, [dashboard, period]);
  const total = rows.reduce(
    (acc, row) => ({
      cached: acc.cached + row.cached,
      cost: acc.cost + row.cost,
      input: acc.input + row.input,
      output: acc.output + row.output,
      total: acc.total + row.total,
    }),
    { cached: 0, cost: 0, input: 0, output: 0, total: 0 },
  );
  // Spend is the figure people budget against; tokens stand in when no run reported a cost.
  const shareBasis: UsageMetric = total.cost > 0 ? "cost" : "tokens";
  const shareOf = (row: { cost: number; total: number }) => {
    const denominator = shareBasis === "cost" ? total.cost : total.total;
    if (denominator <= 0) return 0;
    return (shareBasis === "cost" ? row.cost : row.total) / denominator;
  };
  const sortedRows = [...rows].sort((a, b) => {
    if (a.key === "other" || b.key === "other") return a.key === "other" ? 1 : -1;
    return shareOf(b) - shareOf(a);
  });
  const shareLabelSuffix = shareBasis === "cost" ? " of spend" : " of tokens";

  return (
    <section className="flex shrink-0 flex-col gap-2 rounded-12 border border-border bg-surface p-4">
      <header className={cn(panelHeaderClassName, "flex-wrap")}>
        <div className="min-w-0">
          <h2 className={sectionTitleClassName}>By provider</h2>
          <div className={cn(sectionSubtitleClassName, "whitespace-normal")}>
            Tokens and spend per model provider
          </div>
        </div>
        <SegmentedControl
          size="sm"
          aria-label="Provider usage period"
          value={period}
          onValueChange={(next: string) => setPeriod(next as ProviderUsagePeriod)}
          options={(Object.keys(PROVIDER_USAGE_PERIODS) as ProviderUsagePeriod[]).map((value) => ({
            value,
            label: PROVIDER_USAGE_PERIODS[value].label,
          }))}
        />
      </header>

      {sortedRows.length === 0 ? (
        <div className="rounded-8 border border-dashed border-border px-4 py-5 text-center text-aux text-subtle-foreground">
          {PROVIDER_USAGE_PERIODS[period].empty}
        </div>
      ) : (
        <table className="w-full border-collapse text-ui">
          <caption className="sr-only">
            Usage by provider, {PROVIDER_USAGE_PERIODS[period].label.toLowerCase()}
          </caption>
          <thead>
            <tr>
              <th scope="col" className={cn(providerHeaderCellClassName, "w-[24%]")}>
                Provider
              </th>
              <th scope="col" className={providerHeaderCellClassName}>
                Share
                <span className={providerOffBasisClassName}>{shareLabelSuffix}</span>
              </th>
              {PROVIDER_TABLE_COLUMNS.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={cn(
                    providerHeaderCellClassName,
                    "w-[11%] text-right",
                    providerColumnHiddenClassName(column, shareBasis),
                  )}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row) => (
              <ProviderUsageTableRow
                key={row.key}
                row={row}
                share={shareOf(row)}
                shareBasis={shareBasis}
              />
            ))}
          </tbody>
          {sortedRows.length > 1 && (
            <tfoot>
              <tr>
                <th
                  scope="row"
                  className={cn(
                    providerCellClassName,
                    "text-left font-normal text-muted-foreground",
                  )}
                >
                  Total
                </th>
                <td className={providerCellClassName} />
                <ProviderUsageFigures figures={total} shareBasis={shareBasis} />
              </tr>
            </tfoot>
          )}
        </table>
      )}
    </section>
  );
}

function ProviderUsageTableRow({
  row,
  share,
  shareBasis,
}: {
  row: ProjectProviderUsageRow;
  share: number;
  shareBasis: UsageMetric;
}) {
  const series = PROVIDER_SERIES[row.key];
  return (
    <tr>
      <th scope="row" className={cn(providerCellClassName, "text-left font-normal")}>
        <span className="flex min-w-0 items-center gap-2">
          <ProviderMark providerKey={row.key} />
          <span className="truncate text-foreground">{series.label}</span>
        </span>
      </th>
      <td className={providerCellClassName}>
        {/* The bar takes whatever width the figures leave, so it shrinks before any figure
            clips. Below a 340px dashboard it would be a few pixels wide, so the percentage
            stands alone. */}
        <span className="flex items-center gap-3 @max-[480px]/project-dashboard:gap-2">
          <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-muted @max-[340px]/project-dashboard:hidden">
            <span
              className="block h-full w-full origin-left rounded-full transition-transform duration-200 ease-in-out motion-reduce:transition-none"
              style={{ background: series.color, transform: `scaleX(${Math.min(1, share)})` }}
            />
          </span>
          <span className="w-10 shrink-0 text-right font-mono text-aux text-muted-foreground">
            {fmtShare(share)}
          </span>
        </span>
      </td>
      <ProviderUsageFigures figures={row} shareBasis={shareBasis} />
    </tr>
  );
}

function providerColumnHiddenClassName(
  column: (typeof PROVIDER_TABLE_COLUMNS)[number],
  shareBasis: UsageMetric,
): string | false {
  if (column.detail) return providerDetailClassName;
  return column.basis !== undefined && column.basis !== shareBasis && providerOffBasisClassName;
}

function ProviderUsageFigures({
  figures,
  shareBasis,
}: {
  figures: ProviderUsageFigureSet;
  shareBasis: UsageMetric;
}) {
  return PROVIDER_TABLE_COLUMNS.map((column) => (
    <td
      key={column.key}
      className={cn(
        providerNumericCellClassName,
        providerColumnHiddenClassName(column, shareBasis),
      )}
    >
      {column.format(figures)}
    </td>
  ));
}

function ProviderMark({ providerKey }: { providerKey: ProjectUsageProviderKey }) {
  return (
    <span
      aria-hidden
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-4 border border-border bg-surface"
    >
      {providerKey === "codex" ? (
        <CodexIcon aria-hidden className="size-3.5 text-foreground" />
      ) : (
        <ModelProviderIcon
          provider={providerKey === "claude" ? "anthropic" : null}
          className="size-3.5"
        />
      )}
    </span>
  );
}

interface UsageSeries {
  color: string;
  key: string;
  label: string;
}

type UsageChartDatum = {
  date: string;
  isToday: boolean;
  total: number;
} & Record<string, number | string | boolean>;

const TOKEN_TYPE_SERIES: UsageSeries[] = [
  { color: "var(--brand)", key: "output", label: "Output" },
  { color: "color-mix(in oklch, var(--brand) 45%, transparent)", key: "input", label: "Input" },
  { color: "color-mix(in oklch, var(--brand) 18%, transparent)", key: "cached", label: "Cached" },
];
const COST_SERIES: UsageSeries[] = [{ color: "var(--brand)", key: "cost", label: "Cost" }];

function UsageChart({
  breakdown,
  mode,
  usage,
}: {
  breakdown: UsageBreakdown;
  mode: UsageMetric;
  usage: ProjectDashboardUsageDay[];
}) {
  const isTokens = mode === "tokens";
  const patternId = useId().replaceAll(":", "");
  const totals = useMemo(() => buildProjectUsageChartTotals(usage), [usage]);
  const providerTotals = useMemo(
    () => buildProjectProviderUsageRows(usage.flatMap((day) => day.providers)),
    [usage],
  );
  const series = useMemo<UsageSeries[]>(() => {
    if (breakdown === "provider") {
      return providerTotals.map((row) => ({ ...PROVIDER_SERIES[row.key], key: row.key }));
    }
    return isTokens ? TOKEN_TYPE_SERIES : COST_SERIES;
  }, [breakdown, isTokens, providerTotals]);
  const chartData = useMemo(
    () =>
      usage.map((day, index): UsageChartDatum => {
        const base = { date: day.date, isToday: index === usage.length - 1 };
        if (breakdown === "provider") {
          const values: Record<string, number> = {};
          let total = 0;
          for (const row of buildProjectProviderUsageRows(day.providers)) {
            values[row.key] = isTokens ? row.total : row.cost;
            total += values[row.key];
          }
          return { ...base, ...values, total };
        }
        if (!isTokens) return { ...base, cost: day.costUsd, total: day.costUsd };
        const tokens = buildProjectUsageTokenBreakdown(day);
        return { ...base, ...tokens };
      }),
    [breakdown, isTokens, usage],
  );
  const maximum = Math.max(1, ...chartData.map((datum) => datum.total));
  const firstDate = chartData[0]?.date;
  const lastDate = chartData.at(-1)?.date;
  const xTicks = firstDate
    ? lastDate && firstDate !== lastDate
      ? [firstDate, lastDate]
      : [firstDate]
    : [];

  const fmt = (v: number) => (isTokens ? fmtTokens(v) : fmtCost(v));
  const seriesTotal = (key: string): number => {
    if (breakdown === "provider") {
      const row = providerTotals.find((candidate) => candidate.key === key);
      return row ? (isTokens ? row.total : row.cost) : 0;
    }
    return totals[key as keyof typeof totals];
  };
  const legendSeries = series.length > 1 ? series : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-baseline gap-1 text-aux whitespace-nowrap text-muted-foreground">
          <span className="text-muted-foreground">{isTokens ? "Total" : "Total spend"}</span>
          <span className="font-mono text-aux text-foreground">
            {isTokens ? fmtTokens(totals.total) : fmtCost(totals.cost)}
          </span>
        </span>
        {legendSeries.map((entry) => (
          <span
            key={entry.key}
            className="inline-flex items-baseline gap-1 text-aux whitespace-nowrap text-muted-foreground"
          >
            <span className="size-2 shrink-0 self-center" style={{ background: entry.color }} />
            <span className="text-muted-foreground">{entry.label}</span>
            <span className="font-mono text-foreground">{fmt(seriesTotal(entry.key))}</span>
          </span>
        ))}
      </div>

      <div
        className="min-h-[120px] min-w-0 flex-1"
        role="img"
        aria-label={`${mode} usage${breakdown === "provider" ? " by provider" : ""} over the last 14 days`}
      >
        <ResponsiveContainer
          width="100%"
          height="100%"
          minWidth={0}
          initialDimension={{ width: 560, height: 150 }}
        >
          <BarChart
            data={chartData}
            margin={{ top: 6, right: 12, bottom: 0, left: 0 }}
            barCategoryGap={4}
            barGap={0}
            accessibilityLayer
          >
            <defs>
              {series.map((entry) => (
                <pattern
                  key={entry.key}
                  id={`${patternId}-${entry.key}`}
                  width="6"
                  height="6"
                  patternUnits="userSpaceOnUse"
                  patternTransform="rotate(45)"
                >
                  <rect width="6" height="6" fill={entry.color} />
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
              width={52}
              allowDecimals={!isTokens}
              allowDataOverflow
              domain={[0, maximum]}
              tick={AUXILIARY_CHART_TEXT}
              tickFormatter={(value: number) =>
                `${isTokens ? "" : "$"}${axisNumberFormat.format(value)}`
              }
            />
            <ChartTooltip
              isAnimationActive={false}
              cursor={{ fill: "var(--surface-hover)", radius: 4 }}
              wrapperStyle={{ outline: "none", zIndex: 10 }}
              content={({ active, payload }) => {
                const datum = payload?.[0]?.payload as UsageChartDatum | undefined;
                if (!active || !datum) return null;
                return (
                  <div
                    className="pointer-events-none rounded-8 border border-border bg-popover px-2 py-1 text-aux whitespace-nowrap text-popover-foreground shadow-4"
                    role="status"
                  >
                    <div className="mb-1 text-aux text-muted-foreground">
                      {fmtDateLabel(datum.date)}
                    </div>
                    {series.length > 1 ? (
                      <>
                        {series.map((entry) => (
                          <TooltipRow
                            key={entry.key}
                            color={entry.color}
                            label={entry.label}
                            value={fmt(Number(datum[entry.key] ?? 0))}
                          />
                        ))}
                        <div className="mt-2 flex items-center justify-between gap-3 border-t border-border pt-2 text-aux">
                          <span className="text-muted-foreground">Total</span>
                          <span className="font-mono text-popover-foreground">
                            {fmt(datum.total)}
                          </span>
                        </div>
                      </>
                    ) : (
                      <div className="font-mono text-popover-foreground">{fmt(datum.total)}</div>
                    )}
                  </div>
                );
              }}
            />
            {series.map((entry, index) => (
              <Bar
                key={entry.key}
                dataKey={entry.key}
                name={entry.label}
                stackId="usage"
                fill={entry.color}
                radius={barRadius(index, series.length)}
                isAnimationActive={false}
              >
                {chartData.map((datum) => (
                  <Cell
                    key={datum.date}
                    fill={datum.isToday ? `url(#${patternId}-${entry.key})` : entry.color}
                  />
                ))}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/** Rounds the outer ends of a stack: the base gets a soft foot, the top a cap. */
function barRadius(index: number, count: number): [number, number, number, number] {
  const top = index === count - 1 ? 3 : 0;
  const bottom = index === 0 ? 2 : 0;
  return [top, top, bottom, bottom];
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
