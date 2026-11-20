import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, Copy, FileText, Folder, Search, Terminal, X } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@rome-os/ui/alert";
import { Badge, type BadgeProps } from "@rome-os/ui/badge";
import { Button } from "@rome-os/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@rome-os/ui/card";
import {
  EmptyState,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
} from "@rome-os/ui/empty-state";
import { FilterChipGroup, type FilterChipOption } from "@rome-os/ui/filter-chip-group";
import { IconButton } from "@rome-os/ui/icon-button";
import { Input } from "@rome-os/ui/input";
import {
  List,
  ListRow,
  ListRowContent,
  ListRowDescription,
  ListRowTitle,
} from "@rome-os/ui/list-row";
import { Sheet, SheetDescription, SheetTitle } from "@rome-os/ui/sheet";
import { Spinner } from "@rome-os/ui/spinner";
import { api } from "../api";
import {
  auditItemResult,
  describeAuditItem,
  formatBytes,
  formatClock,
  formatDateTime,
  formatDuration,
  type Locale,
  type Messages,
} from "../i18n";
import type {
  AuditContentPreview,
  AuditItem,
  AuditResult,
  AuditStats,
  AuditSummary,
  ContentName,
} from "../types";

const WINDOW_MS = 24 * 60 * 60 * 1000;
const BUCKET_MS = 10 * 60 * 1000;
const PAGE_SIZE = 50;

type ResultFilter = "all" | AuditResult;
type ActionFilter = "all" | "exec" | "fs.list" | "transfer.open";

export interface AuditViewProps {
  t: Messages;
  locale: Locale;
  summary: AuditSummary;
  counts: Record<ResultFilter, number> | null;
  revision: number;
}

function resultBadgeVariant(result: AuditResult): BadgeProps["variant"] {
  if (result === "succeeded") return "success";
  if (result === "failed") return "destructive";
  return "warning";
}

function ActionIcon({ action }: { action: string | null }) {
  if (action === "fs.list") return <Folder className="size-4 shrink-0 text-muted-foreground" />;
  if (action === "transfer.open") {
    return <FileText className="size-4 shrink-0 text-muted-foreground" />;
  }
  return <Terminal className="size-4 shrink-0 text-muted-foreground" />;
}

interface BucketBar {
  bucket: number;
  succeeded: number;
  failed: number;
  no_result: number;
  total: number;
}

function ActivityHistogram({
  stats,
  selectedBucket,
  onSelectBucket,
  locale,
}: {
  stats: AuditStats;
  selectedBucket: number | null;
  onSelectBucket: (bucket: number | null) => void;
  locale: Locale;
}) {
  const { bars, maxTotal } = useMemo(() => {
    const count =
      stats.bucketMs > 0 ? Math.max(0, Math.ceil((stats.until - stats.since) / stats.bucketMs)) : 0;
    const list: BucketBar[] = Array.from({ length: count }, (_, index) => ({
      bucket: stats.since + index * stats.bucketMs,
      succeeded: 0,
      failed: 0,
      no_result: 0,
      total: 0,
    }));
    for (const g of stats.groups) {
      const entry = list[g.bucket];
      if (!entry) continue;
      entry[g.result] += g.count;
      entry.total += g.count;
    }
    const max = list.reduce((acc, item) => Math.max(acc, item.total), 0);
    return { bars: list, maxTotal: Math.max(1, max) };
  }, [stats]);

  const width = Math.max(bars.length * 6, 120);
  const height = 72;

  return (
    <div className="space-y-2">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="h-20 w-full overflow-visible"
        role="img"
        aria-label="24-hour audit request activity"
      >
        <line
          x1={0}
          y1={height - 1}
          x2={width}
          y2={height - 1}
          stroke="var(--border)"
          strokeWidth={1}
        />
        {bars.map((bar, index) => {
          const x = index * 6;
          const barWidth = 4;
          const selected = selectedBucket === bar.bucket;
          if (bar.total === 0) {
            return (
              <rect
                key={bar.bucket}
                x={x}
                y={height - 3}
                width={barWidth}
                height={2}
                rx={1}
                fill="var(--border-subtle)"
              />
            );
          }
          const scale = (height - 8) / maxTotal;
          const hOk = bar.succeeded * scale;
          const hFail = bar.failed * scale;
          const hNo = bar.no_result * scale;
          let y = height - 2;
          const segments: Array<{ y: number; h: number; fill: string }> = [];
          if (hOk > 0) {
            y -= hOk;
            segments.push({ y, h: Math.max(2, hOk), fill: "var(--success-fg)" });
          }
          if (hNo > 0) {
            y -= hNo;
            segments.push({ y, h: Math.max(2, hNo), fill: "var(--warning-fg)" });
          }
          if (hFail > 0) {
            y -= hFail;
            segments.push({ y, h: Math.max(2, hFail), fill: "var(--destructive-fg)" });
          }
          const label = `${formatClock(bar.bucket, locale)} · ${bar.total}`;
          return (
            <g
              key={bar.bucket}
              className="cursor-pointer"
              opacity={selectedBucket !== null && !selected ? 0.35 : 1}
              onClick={() => onSelectBucket(selected ? null : bar.bucket)}
            >
              <title>{label}</title>
              <rect x={x - 1} y={0} width={6} height={height} fill="transparent" />
              {segments.map((seg, segIdx) => (
                <rect
                  key={segIdx}
                  x={x}
                  y={seg.y}
                  width={barWidth}
                  height={seg.h}
                  rx={1}
                  fill={seg.fill}
                />
              ))}
            </g>
          );
        })}
      </svg>
      <div className="flex items-center justify-between text-aux text-muted-foreground tabular-nums">
        <span>{formatClock(stats.since, locale)}</span>
        <span>{formatClock(stats.until, locale)}</span>
      </div>
    </div>
  );
}

interface ContentDescriptor {
  size: number;
  storedBytes: number;
  sha256: string;
}

interface ContentBlockState {
  name: ContentName;
  preview: AuditContentPreview | null;
  meta: ContentDescriptor;
}

function readContentDescriptor(
  record: Record<string, unknown> | undefined,
  name: ContentName,
): ContentDescriptor | null {
  const content = record?.content;
  if (!content || typeof content !== "object") return null;
  const raw = (content as Record<string, unknown>)[name];
  if (!raw || typeof raw !== "object") return null;
  const info = raw as Record<string, unknown>;
  if (
    typeof info.size !== "number" ||
    typeof info.storedBytes !== "number" ||
    typeof info.sha256 !== "string"
  ) {
    return null;
  }
  return { size: info.size, storedBytes: info.storedBytes, sha256: info.sha256 };
}

function AuditDetailSheet({
  item,
  t,
  locale,
  onClose,
}: {
  item: AuditItem | null;
  t: Messages;
  locale: Locale;
  onClose: () => void;
}) {
  const [contents, setContents] = useState<ContentBlockState[]>([]);
  const [loadingContents, setLoadingContents] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);

  useEffect(() => {
    if (!item) {
      setContents([]);
      return;
    }
    let cancelled = false;
    setLoadingContents(true);

    const candidates: Array<{ name: ContentName; meta: ContentDescriptor }> = [];
    const stdinMeta = readContentDescriptor(item.record, "stdin");
    if (stdinMeta) candidates.push({ name: "stdin", meta: stdinMeta });
    for (const name of ["stdout", "stderr", "file"] as const) {
      const meta = readContentDescriptor(item.end?.record, name);
      if (meta) candidates.push({ name, meta });
    }

    void Promise.all(
      candidates.map(async (c) => {
        try {
          const preview = await api.auditContent(item.seq, c.name);
          return { name: c.name, preview, meta: c.meta };
        } catch {
          return { name: c.name, preview: null, meta: c.meta };
        }
      }),
    ).then((loaded) => {
      if (!cancelled) {
        setContents(loaded);
        setLoadingContents(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [item]);

  if (!item) return null;

  const result = auditItemResult(item);
  const titleText = describeAuditItem(item);
  const args = (item.record.args ?? {}) as Record<string, unknown>;
  const endRec = (item.end?.record ?? {}) as Record<string, unknown>;
  const durationMs =
    typeof endRec.durationMs === "number"
      ? endRec.durationMs
      : item.end
        ? item.end.at - item.at
        : null;
  const envNames = Array.isArray(item.record.envKeys)
    ? (item.record.envKeys as unknown[]).map(String)
    : [];
  const entriesCount = Array.isArray(endRec.entries)
    ? endRec.entries.length
    : typeof endRec.entries === "number"
      ? endRec.entries
      : null;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(titleText);
      setCopiedCmd(true);
      window.setTimeout(() => setCopiedCmd(false), 1600);
    } catch {
      // Ignore clipboard failure on non-secure origins.
    }
  }

  return (
    <Sheet open={item !== null} onClose={onClose} widthClassName="w-full max-w-2xl">
      <div className="flex items-start justify-between gap-4 border-b border-border p-4 sm:p-6">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={resultBadgeVariant(result)}>{t.audit[result]}</Badge>
            <Badge variant="outline">{item.action ?? item.kind}</Badge>
            <span className="font-mono text-aux text-muted-foreground">#{item.seq}</span>
          </div>
          <SheetTitle className="break-all font-mono text-section text-foreground">
            {titleText}
          </SheetTitle>
          <SheetDescription className="text-aux text-muted-foreground">
            {formatDateTime(item.at, locale)}
          </SheetDescription>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton
            label={t.audit.copyCommand}
            size="sm"
            onClick={() => void handleCopy()}
            icon={copiedCmd ? <Check /> : <Copy />}
          />
          <IconButton label={t.audit.closeDetail} size="sm" onClick={onClose} icon={<X />} />
        </div>
      </div>

      <div className="flex-1 space-y-6 overflow-y-auto p-4 sm:p-6">
        {!item.end ? (
          <Alert variant="warning">
            <AlertTriangle />
            <AlertDescription>{t.audit.noEnd}</AlertDescription>
          </Alert>
        ) : item.end.outcome === "interrupted" ? (
          <Alert variant="warning">
            <AlertTriangle />
            <AlertDescription>{t.audit.interrupted}</AlertDescription>
          </Alert>
        ) : null}

        <div className="rounded-12 border border-border bg-surface">
          <List>
            <ListRow size="sm">
              <ListRowContent>
                <ListRowDescription>{t.audit.started}</ListRowDescription>
              </ListRowContent>
              <span className="font-mono text-aux text-foreground">
                {formatDateTime(item.at, locale)}
              </span>
            </ListRow>
            {durationMs !== null ? (
              <ListRow size="sm">
                <ListRowContent>
                  <ListRowDescription>{t.audit.duration}</ListRowDescription>
                </ListRowContent>
                <span className="font-mono text-aux tabular-nums text-foreground">
                  {formatDuration(durationMs)}
                </span>
              </ListRow>
            ) : null}
            {typeof endRec.exitCode === "number" ? (
              <ListRow size="sm">
                <ListRowContent>
                  <ListRowDescription>{t.audit.exitCode}</ListRowDescription>
                </ListRowContent>
                <span className="font-mono text-aux tabular-nums text-foreground">
                  {endRec.exitCode}
                </span>
              </ListRow>
            ) : null}
            {typeof endRec.signal === "string" ? (
              <ListRow size="sm">
                <ListRowContent>
                  <ListRowDescription>{t.audit.signal}</ListRowDescription>
                </ListRowContent>
                <span className="font-mono text-aux text-foreground">{endRec.signal}</span>
              </ListRow>
            ) : null}
            {typeof endRec.errorCode === "string" ? (
              <ListRow size="sm">
                <ListRowContent>
                  <ListRowDescription>{t.audit.errorCode}</ListRowDescription>
                </ListRowContent>
                <span className="font-mono text-aux text-destructive-fg">
                  {endRec.errorCode}
                  {typeof endRec.errorMessage === "string" ? ` — ${endRec.errorMessage}` : ""}
                </span>
              </ListRow>
            ) : null}
            {typeof args.cwd === "string" ? (
              <ListRow size="sm">
                <ListRowContent>
                  <ListRowDescription>{t.audit.cwd}</ListRowDescription>
                </ListRowContent>
                <span className="truncate font-mono text-aux text-foreground">{args.cwd}</span>
              </ListRow>
            ) : null}
            {typeof endRec.pid === "number" ? (
              <ListRow size="sm">
                <ListRowContent>
                  <ListRowDescription>{t.audit.pid}</ListRowDescription>
                </ListRowContent>
                <span className="font-mono text-aux tabular-nums text-foreground">
                  {endRec.pid}
                </span>
              </ListRow>
            ) : null}
            {typeof item.record.requestId === "string" ? (
              <ListRow size="sm">
                <ListRowContent>
                  <ListRowDescription>{t.audit.requestId}</ListRowDescription>
                </ListRowContent>
                <span className="truncate font-mono text-aux text-foreground">
                  {item.record.requestId}
                </span>
              </ListRow>
            ) : null}
            {typeof item.record.from === "string" ? (
              <ListRow size="sm">
                <ListRowContent>
                  <ListRowDescription>{t.audit.from}</ListRowDescription>
                </ListRowContent>
                <div className="flex items-center gap-2">
                  <span className="truncate font-mono text-aux text-foreground">
                    {item.record.from}
                  </span>
                  <Badge variant="muted" title={t.audit.unverifiedTitle}>
                    {t.audit.unverified}
                  </Badge>
                </div>
              </ListRow>
            ) : null}
            {envNames.length > 0 ? (
              <ListRow size="sm">
                <ListRowContent>
                  <ListRowDescription>{t.audit.envVars}</ListRowDescription>
                </ListRowContent>
                <span className="truncate font-mono text-aux text-muted-foreground">
                  {t.audit.envCount(envNames.length)}
                </span>
              </ListRow>
            ) : null}
            {entriesCount !== null ? (
              <ListRow size="sm">
                <ListRowContent>
                  <ListRowDescription>{t.audit.entries}</ListRowDescription>
                </ListRowContent>
                <span className="font-mono text-aux tabular-nums text-foreground">
                  {entriesCount}
                </span>
              </ListRow>
            ) : null}
            {item.action === "transfer.open" && typeof args.direction === "string" ? (
              <ListRow size="sm">
                <ListRowContent>
                  <ListRowDescription>{t.audit.transferDir}</ListRowDescription>
                </ListRowContent>
                <span className="font-mono text-aux text-foreground">{args.direction}</span>
              </ListRow>
            ) : null}
            {item.action === "transfer.open" && typeof args.path === "string" ? (
              <ListRow size="sm">
                <ListRowContent>
                  <ListRowDescription>{t.audit.transferPath}</ListRowDescription>
                </ListRowContent>
                <span className="truncate font-mono text-aux text-foreground">{args.path}</span>
              </ListRow>
            ) : null}
            {item.action === "transfer.open" && typeof endRec.bytes === "number" ? (
              <ListRow size="sm">
                <ListRowContent>
                  <ListRowDescription>{t.audit.transferSize}</ListRowDescription>
                </ListRowContent>
                <span className="font-mono text-aux tabular-nums text-foreground">
                  {formatBytes(endRec.bytes)}
                </span>
              </ListRow>
            ) : null}
          </List>
        </div>

        {loadingContents ? (
          <div className="flex items-center gap-2 text-ui text-muted-foreground">
            <Spinner size="sm" />
            <span>{t.audit.loading}</span>
          </div>
        ) : (
          contents.map(({ name, preview, meta }) => {
            const truncatedByAudit =
              meta.storedBytes < meta.size ? formatBytes(meta.storedBytes) : null;

            return (
              <div key={name} className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-ui font-medium text-foreground">{name}</span>
                  <div className="flex items-center gap-2 text-aux text-muted-foreground tabular-nums">
                    <span>{formatBytes(meta.size)}</span>
                    {truncatedByAudit ? (
                      <Badge variant="warning">{t.audit.truncatedPayload(truncatedByAudit)}</Badge>
                    ) : null}
                  </div>
                </div>
                <p className="break-all font-mono text-aux text-muted-foreground">
                  SHA-256 {meta.sha256}
                </p>
                {preview === null ? (
                  <div className="rounded-8 border border-border bg-surface-muted px-4 py-3 text-aux text-muted-foreground">
                    {t.audit.pruned}
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-8 border border-border bg-surface-muted">
                    <pre className="max-h-72 overflow-auto p-4 font-mono text-aux whitespace-pre-wrap break-all text-foreground">
                      {preview.text || "(empty)"}
                    </pre>
                    {preview.truncated ? (
                      <div className="border-t border-border px-4 py-2 text-aux text-muted-foreground">
                        {t.audit.previewLimit}
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </Sheet>
  );
}

export function AuditView({ t, locale, summary, counts, revision }: AuditViewProps) {
  const [resultFilter, setResultFilter] = useState<ResultFilter>("all");
  const [actionFilter, setActionFilter] = useState<ActionFilter>("all");
  const [searchInput, setSearchInput] = useState("");
  const [searchText, setSearchText] = useState("");
  const [selectedBucket, setSelectedBucket] = useState<number | null>(null);
  const [stats, setStats] = useState<AuditStats | null>(null);
  const [items, setItems] = useState<AuditItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<AuditItem | null>(null);

  const requestSeqRef = useRef(0);
  const extraPagesLoadedRef = useRef(false);
  const prevQueryKeyRef = useRef("");

  useEffect(() => {
    const timer = window.setTimeout(() => setSearchText(searchInput.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const queryParams = useMemo(() => {
    return {
      limit: PAGE_SIZE,
      result: resultFilter === "all" ? undefined : resultFilter,
      action: actionFilter === "all" ? undefined : actionFilter,
      text: searchText || undefined,
      since: selectedBucket ?? undefined,
      until: selectedBucket !== null ? selectedBucket + BUCKET_MS : undefined,
    };
  }, [actionFilter, resultFilter, searchText, selectedBucket]);

  const queryKey = useMemo(() => JSON.stringify(queryParams), [queryParams]);

  const loadData = useCallback(
    async (signal: AbortSignal, statsOnly: boolean) => {
      if (summary.status.state !== "ok") {
        setItems([]);
        setStats(null);
        setLoading(false);
        return;
      }
      const seq = ++requestSeqRef.current;
      if (!statsOnly) setLoading(true);
      setError(null);
      const until = (Math.floor(Date.now() / BUCKET_MS) + 1) * BUCKET_MS;
      const since = until - WINDOW_MS;
      try {
        if (statsOnly) {
          const nextStats = await api.auditStats(since, until, BUCKET_MS, signal);
          if (signal.aborted || seq !== requestSeqRef.current) return;
          setStats(nextStats);
          return;
        }
        const [page, nextStats] = await Promise.all([
          api.auditItems(queryParams, signal),
          api.auditStats(since, until, BUCKET_MS, signal),
        ]);
        if (signal.aborted || seq !== requestSeqRef.current) return;
        setItems(page.items);
        setHasMore(page.hasMore);
        setStats(nextStats);
      } catch (err) {
        if (signal.aborted || seq !== requestSeqRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!signal.aborted && seq === requestSeqRef.current && !statsOnly) {
          setLoading(false);
        }
      }
    },
    [queryParams, summary.status.state],
  );

  useEffect(() => {
    const queryChanged = prevQueryKeyRef.current !== queryKey;
    prevQueryKeyRef.current = queryKey;
    if (queryChanged) {
      extraPagesLoadedRef.current = false;
    }
    const controller = new AbortController();
    const statsOnly = !queryChanged && extraPagesLoadedRef.current;
    void loadData(controller.signal, statsOnly);
    return () => {
      controller.abort();
    };
  }, [loadData, queryKey, revision]);

  async function handleLoadMore() {
    const last = items[items.length - 1];
    if (!last || loadingMore) return;
    const seq = requestSeqRef.current;
    setLoadingMore(true);
    try {
      const next = await api.auditItems({ ...queryParams, beforeSeq: last.seq });
      if (seq !== requestSeqRef.current) return;
      extraPagesLoadedRef.current = true;
      setItems((prev) => [...prev, ...next.items]);
      setHasMore(next.hasMore);
    } catch (err) {
      if (seq !== requestSeqRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingMore(false);
    }
  }

  const resultOptions: FilterChipOption<ResultFilter>[] = [
    { value: "all", label: t.audit.all, count: counts?.all },
    { value: "succeeded", label: t.audit.succeeded, count: counts?.succeeded },
    { value: "failed", label: t.audit.failed, count: counts?.failed },
    { value: "no_result", label: t.audit.no_result, count: counts?.no_result },
  ];

  const actionOptions: FilterChipOption<ActionFilter>[] = [
    { value: "all", label: t.audit.all },
    { value: "exec", label: "exec" },
    { value: "fs.list", label: "fs.list" },
    { value: "transfer.open", label: "transfer.open" },
  ];

  const retentionGib = (summary.retention.maxBytes / (1024 * 1024 * 1024)).toFixed(0);
  const hasFilters =
    resultFilter !== "all" ||
    actionFilter !== "all" ||
    searchText.length > 0 ||
    selectedBucket !== null;

  if (summary.status.state !== "ok") {
    return (
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertTitle>{t.audit.unavailableTitle}</AlertTitle>
        <AlertDescription>
          {summary.status.message} — {t.audit.unavailableHint}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      {stats ? (
        <Card>
          <CardHeader>
            <CardTitle>{t.audit.chartTitle}</CardTitle>
            <CardDescription>{t.audit.chartLegend}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <ActivityHistogram
              stats={stats}
              selectedBucket={selectedBucket}
              onSelectBucket={setSelectedBucket}
              locale={locale}
            />
            {selectedBucket !== null ? (
              <div className="flex items-center justify-between gap-2 text-aux text-muted-foreground">
                <span className="font-mono">
                  {formatClock(selectedBucket, locale)} –{" "}
                  {formatClock(selectedBucket + BUCKET_MS, locale)}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedBucket(null)}
                >
                  <X data-icon="inline-start" />
                  {t.audit.clearBucket}
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <FilterChipGroup
            aria-label={t.audit.filterLabel}
            options={resultOptions}
            value={resultFilter}
            onValueChange={setResultFilter}
          />
          <div className="w-full sm:w-72">
            <Input
              size="sm"
              type="search"
              icon={<Search />}
              placeholder={t.audit.searchPlaceholder}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>
        </div>
        <FilterChipGroup
          aria-label={t.audit.actionFilterLabel}
          options={actionOptions}
          value={actionFilter}
          onValueChange={setActionFilter}
        />
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardContent className="px-0">
          {loading && items.length === 0 ? (
            <EmptyState>
              <EmptyStateIcon>
                <Spinner />
              </EmptyStateIcon>
              <EmptyStateTitle>{t.audit.loading}</EmptyStateTitle>
            </EmptyState>
          ) : items.length === 0 ? (
            <EmptyState>
              <EmptyStateIcon>
                <Terminal />
              </EmptyStateIcon>
              <EmptyStateTitle>
                {hasFilters ? t.audit.noMatchesTitle : t.audit.emptyTitle}
              </EmptyStateTitle>
              <EmptyStateDescription>
                {hasFilters ? t.audit.noMatchesDescription : t.audit.emptyDescription}
              </EmptyStateDescription>
            </EmptyState>
          ) : (
            <List>
              {items.map((item) => {
                const res = auditItemResult(item);
                const endRec = (item.end?.record ?? {}) as Record<string, unknown>;
                const durationMs =
                  typeof endRec.durationMs === "number"
                    ? endRec.durationMs
                    : item.end
                      ? item.end.at - item.at
                      : null;

                return (
                  <ListRow
                    key={item.seq}
                    asChild
                    interactive
                    selected={selectedItem?.seq === item.seq}
                    size="md"
                  >
                    <button type="button" onClick={() => setSelectedItem(item)}>
                      <ActionIcon action={item.action} />
                      <ListRowContent>
                        <ListRowTitle className="truncate font-mono">
                          {describeAuditItem(item)}
                        </ListRowTitle>
                        <ListRowDescription className="flex flex-wrap items-center gap-2 font-mono tabular-nums">
                          <span>{formatDateTime(item.at, locale)}</span>
                          {durationMs !== null ? <span>· {formatDuration(durationMs)}</span> : null}
                          {typeof endRec.exitCode === "number" ? (
                            <span>· exit {endRec.exitCode}</span>
                          ) : null}
                          {typeof endRec.errorCode === "string" ? (
                            <span>· {endRec.errorCode}</span>
                          ) : null}
                        </ListRowDescription>
                      </ListRowContent>
                      <Badge variant={resultBadgeVariant(res)}>{t.audit[res]}</Badge>
                    </button>
                  </ListRow>
                );
              })}
            </List>
          )}
        </CardContent>
      </Card>

      {hasMore ? (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            size="md"
            disabled={loadingMore}
            onClick={() => void handleLoadMore()}
          >
            {loadingMore ? <Spinner size="sm" data-icon="inline-start" /> : null}
            {loadingMore ? t.audit.loading : t.audit.loadMore}
          </Button>
        </div>
      ) : null}

      <p className="text-aux text-muted-foreground">
        {t.audit.retention(summary.retention.maxAgeDays, retentionGib)} · {summary.path} (
        {formatBytes(summary.bytes)})
      </p>

      <AuditDetailSheet
        item={selectedItem}
        t={t}
        locale={locale}
        onClose={() => setSelectedItem(null)}
      />
    </div>
  );
}
