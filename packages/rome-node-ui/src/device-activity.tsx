import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Button } from "@rome-os/ui/button";
import { Card } from "@rome-os/ui/card";
import { cn } from "@rome-os/ui/cn";
import { FilterChipGroup } from "@rome-os/ui/filter-chip-group";
import { IconButton } from "@rome-os/ui/icon-button";
import { Input } from "@rome-os/ui/input";
import { List, ListRow } from "@rome-os/ui/list-row";
import { PageHeader, PageHeaderNav, PageHeading, PageTitle } from "@rome-os/ui/page";
import { Sheet, SheetDescription, SheetTitle } from "@rome-os/ui/sheet";
import { Check, Copy, Search, X } from "lucide-react";
import {
  byteFormat,
  clock,
  commandText,
  formatDuration,
  platformOf,
  scriptOf,
  startOfDay,
  summarize,
} from "./format.js";
import { LoadChart } from "./load-chart.js";
import { format, messagesFor, plural, type NodeUiMessages } from "./messages.js";
import { DeviceIcon, ResultMark, resultPaint, useNow } from "./parts.js";
import type { NodeActionResult, NodeActionRow } from "./protocol.js";
import { BUCKET_MS, failureRate, statsByPeer, windowStart } from "./stats.js";
import type { NodeDevice } from "./types.js";
import {
  activeTextFilter,
  useAction,
  useActions,
  useNodeSocket,
  useStats,
} from "./use-node-socket.js";

/** At this width the command detail sits beside the list instead of in a sheet. */
const SPLIT_PX = 880;

export interface NodeDeviceActivityProps {
  /** WebSocket URL of a backend that forwards the daemon's observation methods unchanged. */
  url: string;
  device: NodeDevice;
  /** A back link to the devices overview, rendered above the device name. */
  nav?: ReactNode;
  /** BCP 47 tag for text, dates, and numbers. Chinese for `zh*`, English otherwise. */
  locale?: string;
  /** The action shown in detail. The host keeps it in the URL. */
  selected?: number | null;
  onSelect?: (id: number | null) => void;
}

type ResultFilter = NodeActionResult | "all";

interface Context {
  m: NodeUiMessages;
  locale: string | undefined;
  bytes: (value: number) => string;
}

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

function CopyCommand({ text, m }: { text: string; m: NodeUiMessages }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      variant="outline"
      size="sm"
      className="self-start"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => setCopied(true));
      }}
    >
      {copied ? (
        <Check data-icon="inline-start" aria-hidden />
      ) : (
        <Copy data-icon="inline-start" aria-hidden />
      )}
      {copied ? m.command.copied : m.command.copy}
    </Button>
  );
}

/** Everything the log knows about one action. */
function CommandDetail({
  row,
  device,
  now,
  context: { m, locale, bytes },
}: {
  row: NodeActionRow;
  device: NodeDevice;
  now: number;
  context: Context;
}) {
  const script = scriptOf(row);
  const day = startOfDay(row.startedAt);
  const today = startOfDay(now);
  const facts: [string, ReactNode][] = [
    [
      m.command.started,
      `${
        day === today
          ? m.detail.today
          : new Date(row.startedAt).toLocaleDateString(locale, { month: "short", day: "numeric" })
      } ${clock(row.startedAt, locale)}`,
    ],
    [m.command.duration, formatDuration((row.endedAt ?? now) - row.startedAt)],
  ];
  if (row.exitCode !== null) facts.push([m.command.exit, String(row.exitCode)]);
  if (row.signal) facts.push([m.command.signal, row.signal]);
  if (row.errorCode) facts.push([m.command.error, row.errorCode]);
  if (row.endedAt !== null)
    facts.push([m.command.output, bytes(row.transfer?.bytes ?? row.stdoutBytes)]);
  if (row.stderrBytes) facts.push([m.command.errors, bytes(row.stderrBytes)]);
  if (script) facts.push([m.command.shell, script.shell]);
  facts.push([m.command.cwd, row.cwd ?? "—"]);
  if (row.action !== "exec") facts.push([m.command.action, `${row.action} · ${row.mode}`]);
  if (row.transfer?.sha256) facts.push(["SHA-256", row.transfer.sha256]);
  return (
    <div className="flex flex-col gap-4">
      <p className="flex items-center gap-2 font-mono text-aux text-muted-foreground">
        <ResultMark row={row} m={m} />
        <span aria-hidden>·</span>
        <span className="truncate">{device.name}</span>
      </p>
      <pre className="max-h-64 overflow-auto rounded-8 bg-muted p-3 font-mono text-aux whitespace-pre-wrap break-all">
        <span className="select-none text-muted-foreground">$ </span>
        <code>{commandText(row)}</code>
      </pre>
      <CopyCommand text={commandText(row)} m={m} />
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        {facts.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-aux text-muted-foreground">{label}</dt>
            <dd className="break-all font-mono text-aux text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
      {row.truncated && <p className="text-aux text-muted-foreground">{m.command.truncated}</p>}
    </div>
  );
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

/**
 * One device's commands over the last 24 hours: the totals and the load chart, a result filter
 * with counts, search, the command list, and the selected command's detail, beside the list on
 * a wide container and in a sheet on a narrow one.
 * Needs `@rome-os/node-ui/styles.css` in the host's Tailwind build.
 */
export function NodeDeviceActivity({
  url,
  device,
  nav,
  locale,
  selected: selectedProp,
  onSelect,
}: NodeDeviceActivityProps) {
  const m = messagesFor(locale);
  const bytes = useMemo(() => byteFormat(locale), [locale]);
  const context: Context = { m, locale, bytes };
  const socket = useNodeSocket(url);
  const now = useNow(socket.running.length ? 1000 : 30_000);
  const since = windowStart(now);
  const statsQuery = useMemo(
    () => ({ since, bucketMs: BUCKET_MS, peer: device.id }),
    [since, device.id],
  );
  const { stats, supported } = useStats(socket, statsQuery);
  const series = useMemo(
    () => (stats ? statsByPeer(stats).get(device.id.toLowerCase()) : undefined),
    [stats, device.id],
  );
  const [result, setResult] = useState<ResultFilter>("all");
  const [bucket, setBucket] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [text, setText] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setText(search), 300);
    return () => window.clearTimeout(timer);
  }, [search]);
  const [localSelected, setLocalSelected] = useState<number | null>(null);
  const selectedId = selectedProp === undefined ? localSelected : selectedProp;
  const select = (id: number | null) => {
    if (selectedProp === undefined) setLocalSelected(id);
    onSelect?.(id);
  };

  const filters = useMemo(
    () => ({
      peer: device.id,
      ...(result === "all" ? {} : { result }),
      since: bucket ?? since,
      ...(bucket === null ? {} : { until: bucket + BUCKET_MS }),
      ...(text ? { text } : {}),
    }),
    [device.id, result, bucket, since, text],
  );
  const list = useActions(socket, filters);
  const fetched = useAction(
    socket,
    selectedId !== null && !list.rows.some((row) => row.id === selectedId) ? selectedId : null,
    device.id,
  );
  const selectedRow = list.rows.find((row) => row.id === selectedId) ?? fetched;
  const [frame, width] = useWidth<HTMLDivElement>();
  const wide = width >= SPLIT_PX;
  const countText = (count: number) => plural(m.detail.count, count, locale);
  const counts = series?.counts;
  const scoped =
    bucket === null ? counts : series?.buckets.find((item) => item.start === bucket)?.counts;
  const rate = counts ? failureRate(counts) : null;
  const searchShort = search.trim().length > 0 && !activeTextFilter(search);
  const platform = platformOf(device.platform).label;
  const today = startOfDay(now);

  // Groups rows by day, newest first.
  const groups: { day: number; rows: NodeActionRow[] }[] = [];
  for (const row of list.rows) {
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

  const detail = selectedRow ? (
    <CommandDetail row={selectedRow} device={device} now={now} context={context} />
  ) : null;

  return (
    <div ref={frame} className="flex min-w-0 flex-col gap-6">
      <PageHeader>
        {nav && <PageHeaderNav>{nav}</PageHeaderNav>}
        <div className="flex min-w-0 items-center gap-3">
          <DeviceIcon platform={device.platform} status={device.status} className="size-10" />
          <PageHeading className="min-w-0">
            <PageTitle className="break-words">{device.name}</PageTitle>
            <p className="font-mono text-aux text-muted-foreground">
              {[platform, device.status ? m.status[device.status] : null]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </PageHeading>
        </div>
      </PageHeader>

      {socket.link !== "open" && (
        <p role="status" className="text-ui text-muted-foreground">
          {m.link[socket.link]}
        </p>
      )}

      <Card className="gap-4 px-4">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono text-display tabular-nums text-foreground">
                {(counts?.all ?? 0).toLocaleString(locale)}
              </span>
              <span className="text-ui text-muted-foreground">
                {plural(m.detail.commandsInDay, counts?.all ?? 0, locale)}
              </span>
            </p>
            {counts && counts.all > 0 && (
              <p className="font-mono text-aux text-muted-foreground tabular-nums">
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
            {!supported && <p className="text-aux text-muted-foreground">{m.statsUnavailable}</p>}
          </div>
          <FilterChipGroup
            aria-label={m.detail.resultFilter}
            options={options}
            value={result}
            onValueChange={setResult}
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
            onSelect={setBucket}
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
              onChange={(event) => setSearch(event.target.value)}
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
                onClick={() => setBucket(null)}
              />
            </span>
          )}
          {scoped && !text && (
            <span className="font-mono text-aux text-muted-foreground tabular-nums">
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
              {list.loading ? m.detail.loading : m.detail.empty}
            </p>
          ) : (
            groups.map((group) => (
              <section key={group.day} aria-label={dayLabel(group.day)}>
                <h3 className="border-b border-border-subtle bg-surface-muted px-[var(--row-px-sm)] py-2 text-aux font-medium text-muted-foreground">
                  {dayLabel(group.day)}
                </h3>
                <List asChild>
                  <ul aria-busy={list.loading}>
                    {group.rows.map((row) => (
                      <CommandRow
                        key={row.id}
                        row={row}
                        selected={row.id === selectedId}
                        onSelect={() => select(row.id === selectedId && wide ? null : row.id)}
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
          {list.hasMore && (
            <div className="border-t border-border p-3">
              <Button variant="outline" size="sm" disabled={list.loading} onClick={list.loadMore}>
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
          onClose={() => select(null)}
          widthClassName="w-full max-w-md"
          className="overflow-y-auto"
        >
          <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
            <SheetTitle className="truncate text-section">{device.name}</SheetTitle>
            <SheetDescription className="sr-only">
              {selectedRow ? summarize(selectedRow) : null}
            </SheetDescription>
            <IconButton label={m.detail.close} icon={<X />} onClick={() => select(null)} />
          </div>
          <div className="p-4">{detail}</div>
        </Sheet>
      )}
    </div>
  );
}
