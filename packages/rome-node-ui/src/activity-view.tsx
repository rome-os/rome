import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Button } from "@rome-os/ui/button";
import { Card } from "@rome-os/ui/card";
import { cn } from "@rome-os/ui/cn";
import { FilterChipGroup } from "@rome-os/ui/filter-chip-group";
import { IconButton } from "@rome-os/ui/icon-button";
import { Input } from "@rome-os/ui/input";
import { List, ListRow } from "@rome-os/ui/list-row";
import { PageActions, PageHeader, PageHeaderNav, PageHeading, PageTitle } from "@rome-os/ui/page";
import { Sheet, SheetDescription, SheetTitle } from "@rome-os/ui/sheet";
import { Search, X } from "lucide-react";
import {
  activeTextFilter,
  clock,
  formatDuration,
  platformOf,
  startOfDay,
  summarize,
} from "./format.js";
import { LoadChart } from "./load-chart.js";
import { format, messagesFor, plural, type NodeUiMessages } from "./messages.js";
import { DeviceIcon, ResultMark, resultPaint } from "./parts.js";
import type { NodeActionResult, NodeActionRow } from "./protocol.js";
import { BUCKET_MS, failureRate, type DeviceStats, type ResultCounts } from "./stats.js";
import type { NodeDevice } from "./types.js";

/** At this width the command detail sits beside the list instead of in a sheet. */
const SPLIT_PX = 880;

function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function CommandRow({
  row,
  selected,
  onSelect,
  wide,
  now,
  locale,
  m,
}: {
  row: NodeActionRow;
  selected: boolean;
  onSelect(): void;
  wide: boolean;
  now: number;
  locale: string | undefined;
  m: NodeUiMessages;
}) {
  return (
    <li>
      <ListRow asChild interactive size="sm" selected={selected}>
        <button
          type="button"
          aria-current={selected || undefined}
          onClick={onSelect}
          className={cn(
            "grid w-full items-center gap-3 text-left",
            wide
              ? "grid-cols-[4.5rem_minmax(0,1fr)_4.5rem_6rem]"
              : "grid-cols-[0.75rem_4.5rem_minmax(0,1fr)]",
          )}
        >
          {!wide && (
            <span className="flex justify-center">
              <ResultMark row={row} m={m} label={false} />
            </span>
          )}
          <span className="font-mono text-aux text-muted-foreground tabular-nums">
            {clock(row.startedAt, locale)}
          </span>
          <span className="truncate font-mono text-ui text-foreground">{summarize(row)}</span>
          {wide && (
            <>
              <span className="text-right font-mono text-aux text-muted-foreground tabular-nums">
                {formatDuration((row.endedAt ?? now) - row.startedAt)}
              </span>
              <ResultMark row={row} m={m} />
            </>
          )}
        </button>
      </ListRow>
    </li>
  );
}

/** What `NodeActivityView` shows: the data and the state its host owns. */
export interface NodeActivityViewProps {
  device: NodeDevice;
  /** Replaces the device name in the header. */
  title?: string;
  /** Replaces the platform and status line under the title. */
  subtitle?: string;
  nav?: ReactNode;
  /** The header's "…" menu. */
  actions?: ReactNode;
  /** A line or alert under the header, such as a lost connection. */
  notice?: ReactNode;
  /** Shows only the header and the notice, when there is no activity to read. */
  hideActivity?: boolean;
  locale?: string;
  now: number;
  /** The last 24 hours: the totals and the chart. */
  series?: DeviceStats;
  statsUnavailable?: boolean;
  /** The filter counts. Defaults to the 24-hour totals of `series`. */
  counts?: ResultCounts;
  result: NodeActionResult | "all";
  onResult(result: NodeActionResult | "all"): void;
  bucket: number | null;
  onBucket(bucket: number | null): void;
  search: string;
  onSearch(search: string): void;
  /** Minimum trimmed length before showing the short-query hint. Defaults to 3. */
  minSearchLength?: number;
  /** True while a text filter applies, which hides the count beside the search box. */
  searching: boolean;
  rows: NodeActionRow[];
  loading: boolean;
  hasMore: boolean;
  onLoadMore(): void;
  selectedId: number | null;
  selectedRow: NodeActionRow | null;
  onSelect(id: number | null): void;
  renderDetail(row: NodeActionRow): ReactNode;
}

/**
 * The device activity layout without a data source: the header, the totals with the result
 * filter and the load chart, search, the day-grouped command list, and the selected command's
 * detail beside the list on a wide container and in a sheet on a narrow one.
 * Needs `@rome-os/node-ui/styles.css` or `@rome-os/node-ui/activity.css` in the host's Tailwind build.
 */
export function NodeActivityView({
  device,
  title,
  subtitle,
  nav,
  actions,
  notice,
  hideActivity,
  locale,
  now,
  series,
  statsUnavailable,
  counts: countsProp,
  result,
  onResult,
  bucket,
  onBucket,
  search,
  onSearch,
  minSearchLength = 3,
  searching,
  rows,
  loading,
  hasMore,
  onLoadMore,
  selectedId,
  selectedRow,
  onSelect,
  renderDetail,
}: NodeActivityViewProps) {
  const m = messagesFor(locale);
  const [frame, width] = useWidth<HTMLDivElement>();
  const wide = width >= SPLIT_PX;
  const countText = (count: number) => plural(m.detail.count, count, locale);
  const counts = series?.counts;
  const scoped =
    bucket === null
      ? (countsProp ?? counts)
      : series?.buckets.find((item) => item.start === bucket)?.counts;
  const rate = counts ? failureRate(counts) : null;
  const searchShort =
    minSearchLength > 1 && search.trim().length > 0 && !activeTextFilter(search, minSearchLength);
  const platform = platformOf(device.platform).label;
  const today = startOfDay(now);

  // Groups rows by day, newest first.
  const groups: { day: number; rows: NodeActionRow[] }[] = [];
  for (const row of rows) {
    const day = startOfDay(row.startedAt);
    const last = groups.at(-1);
    if (last?.day === day) last.rows.push(row);
    else groups.push({ day, rows: [row] });
  }
  const dayLabel = (day: number) =>
    day === today
      ? m.detail.today
      : day === startOfDay(today - 1)
        ? m.detail.yesterday
        : new Date(day).toLocaleDateString(locale, { month: "short", day: "numeric" });

  const options = (["all", "running", "succeeded", "failed", "no_result"] as const).map(
    (value) => ({
      value,
      label:
        value === "all" ? (
          m.result.all
        ) : (
          <span className="inline-flex items-center gap-2">
            <span className={cn("size-1.5 rounded-full", resultPaint[value])} aria-hidden />
            {m.result[value]}
          </span>
        ),
      ...(scoped ? { count: scoped[value] } : {}),
    }),
  );

  const detail = selectedRow ? renderDetail(selectedRow) : null;
  return (
    <div ref={frame} className="flex min-w-0 flex-col gap-6">
      <PageHeader>
        {nav && <PageHeaderNav>{nav}</PageHeaderNav>}
        <div className="flex min-w-0 items-center gap-3">
          <DeviceIcon platform={device.platform} status={device.status} className="size-10" />
          <PageHeading className="min-w-0">
            <PageTitle className="break-words">{title ?? device.name}</PageTitle>
            <p className="text-aux text-muted-foreground">
              {subtitle ??
                [platform, device.status ? m.status[device.status] : null]
                  .filter(Boolean)
                  .join(" · ")}
            </p>
          </PageHeading>
        </div>
        {actions && <PageActions>{actions}</PageActions>}
      </PageHeader>

      {notice}

      {!hideActivity && (
        <>
          <Card className="gap-4 px-4">
            <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
              <div className="flex min-w-0 flex-col gap-1">
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-display tabular-nums text-foreground">
                    {(counts?.all ?? 0).toLocaleString(locale)}
                  </span>
                  <span className="text-ui text-muted-foreground">
                    {plural(m.detail.commandsInDay, counts?.all ?? 0, locale)}
                  </span>
                </p>
                {counts && counts.all > 0 && (
                  <p className="text-aux text-muted-foreground tabular-nums">
                    {[
                      format(m.detail.average, {
                        rate: (counts.all / (24 * 60)).toLocaleString(locale, {
                          maximumFractionDigits: 1,
                        }),
                      }),
                      series?.peak
                        ? format(m.detail.peakAt, {
                            count: series.peak.counts.all,
                            time: clock(series.peak.start, locale, false),
                          })
                        : null,
                      rate !== null
                        ? format(m.detail.failedShare, {
                            rate: rate.toLocaleString(locale, {
                              style: "percent",
                              maximumFractionDigits: 1,
                            }),
                          })
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                )}
                {statsUnavailable && (
                  <p className="text-aux text-muted-foreground">{m.statsUnavailable}</p>
                )}
              </div>
              <FilterChipGroup
                aria-label={m.detail.resultFilter}
                options={options}
                value={result}
                onValueChange={onResult}
                className="max-w-full"
              />
            </div>
            {series && (
              <LoadChart
                buckets={series.buckets}
                bucketMs={BUCKET_MS}
                m={m}
                locale={locale}
                size="lg"
                countText={countText}
                selected={bucket}
                onSelect={onBucket}
              />
            )}
          </Card>

          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-48 flex-1">
                <Input
                  type="search"
                  icon={<Search />}
                  value={search}
                  onChange={(event) => onSearch(event.target.value)}
                  placeholder={m.detail.searchPlaceholder}
                  aria-label={m.detail.search}
                />
              </div>
              {bucket !== null && (
                <span className="inline-flex h-[var(--control-h-md)] items-center gap-1 rounded-[var(--control-r-md)] border border-border pl-3 pr-1 font-mono text-aux text-foreground tabular-nums">
                  {format(m.detail.window, {
                    from: clock(bucket, locale, false),
                    to: clock(bucket + BUCKET_MS, locale, false),
                  })}
                  <IconButton
                    size="xs"
                    label={m.detail.clearWindow}
                    icon={<X />}
                    onClick={() => onBucket(null)}
                  />
                </span>
              )}
              {scoped && !searching && (
                <span className="text-aux text-muted-foreground tabular-nums">
                  {plural(m.detail.count, scoped[result], locale)}
                </span>
              )}
            </div>
            {searchShort && <p className="text-aux text-muted-foreground">{m.detail.searchHint}</p>}
          </div>

          <div className={cn("grid items-start gap-4", wide && "grid-cols-[minmax(0,1fr)_22rem]")}>
            <Card className="gap-0 overflow-hidden py-0">
              {wide && (
                <div className="grid grid-cols-[4.5rem_minmax(0,1fr)_4.5rem_6rem] gap-3 border-b border-border px-[var(--row-px-sm)] py-2 text-aux text-muted-foreground">
                  <span>{m.detail.columns.time}</span>
                  <span>{m.detail.columns.command}</span>
                  <span className="text-right">{m.detail.columns.duration}</span>
                  <span>{m.detail.columns.result}</span>
                </div>
              )}
              {groups.length === 0 ? (
                <p className="px-4 py-6 text-ui text-muted-foreground">
                  {loading ? m.detail.loading : m.detail.empty}
                </p>
              ) : (
                groups.map((group) => (
                  <section key={group.day} aria-label={dayLabel(group.day)}>
                    <h3 className="border-b border-border-subtle bg-surface-muted px-[var(--row-px-sm)] py-2 text-aux font-medium text-muted-foreground">
                      {dayLabel(group.day)}
                    </h3>
                    <List asChild>
                      <ul aria-busy={loading}>
                        {group.rows.map((row) => (
                          <CommandRow
                            key={row.id}
                            row={row}
                            selected={row.id === selectedId}
                            onSelect={() => onSelect(row.id === selectedId && wide ? null : row.id)}
                            wide={wide}
                            now={now}
                            locale={locale}
                            m={m}
                          />
                        ))}
                      </ul>
                    </List>
                  </section>
                ))
              )}
              {hasMore && (
                <div className="border-t border-border p-3">
                  <Button variant="outline" size="sm" disabled={loading} onClick={onLoadMore}>
                    {m.detail.loadMore}
                  </Button>
                </div>
              )}
            </Card>
            {wide && (
              <Card className="sticky top-4 px-4">
                {detail ?? <p className="text-ui text-muted-foreground">{m.detail.select}</p>}
              </Card>
            )}
          </div>

          {!wide && (
            <Sheet
              open={Boolean(selectedRow)}
              onClose={() => onSelect(null)}
              widthClassName="w-full max-w-md"
              className="overflow-y-auto"
            >
              <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
                <SheetTitle className="truncate text-section">{title ?? device.name}</SheetTitle>
                <SheetDescription className="sr-only">
                  {selectedRow ? summarize(selectedRow) : null}
                </SheetDescription>
                <IconButton label={m.detail.close} icon={<X />} onClick={() => onSelect(null)} />
              </div>
              <div className="p-4">{detail}</div>
            </Sheet>
          )}
        </>
      )}
    </div>
  );
}
